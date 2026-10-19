// Netlify Function (v1 classic handler): Train PWA -> Notion "Training - Session Log".
// Idempotent upsert keyed by Session ID. Holds NOTION_TOKEN server-side; the PWA never sees it.
//
// Env vars (set in Netlify site settings -- NEVER committed to this repo):
//   NOTION_TOKEN           Notion internal integration secret
//   NOTION_DATA_SOURCE_ID  data source ID of "Training - Session Log" (bb53c37f-...)
//   TRAIN_SYNC_SECRET      optional shared key; if set, requests must send matching X-Train-Sync-Key
//   ALLOWED_ORIGIN         optional extra allowed origin(s), comma-separated; the built-in allowlist
//                          below (GitHub Pages + the Capacitor iOS shell) always applies
//
// Notion API version 2025-09-03 (data-source-scoped):
//   - dedup query: POST /v1/data_sources/{id}/query   (filter Session ID == sessionId)
//   - create:      POST /v1/pages                      (parent {type:'data_source_id'})
//   - update:      PATCH /v1/pages/{page_id}
//
// Failure contract: localStorage in the PWA is the source of truth; this endpoint is a mirror.
// A timeout that creates the row but never returns is healed on the next push: the dedup query
// finds the existing row by Session ID and the call returns success instead of duplicating.

import {
  validatePayload,
  withinSizeLimit,
  toNotionProperties,
  toNotionChildren,
} from '../../lib/session-mapping.mjs';

const NOTION_VERSION = '2025-09-03';
// CORS allowlist: the PWA on GitHub Pages and the Capacitor iOS shell (its WebView origin is
// capacitor://localhost). The matching Origin is echoed back with Vary: Origin; any other
// Origin gets no Access-Control-Allow-Origin header, so a browser page elsewhere cannot read
// the response. CORS is not auth: the optional X-Train-Sync-Key gate stays the gate.
const DEFAULT_ORIGINS = ['https://hyndesyte.github.io', 'capacitor://localhost'];

export function allowedOrigins(env = process.env) {
  const extra = String(env.ALLOWED_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean);
  return [...DEFAULT_ORIGINS, ...extra].map((o) => o.toLowerCase());
}

export function corsHeaders(event, env = process.env) {
  const h = event.headers || {};
  const raw = h.origin || h.Origin || '';
  const match = raw && allowedOrigins(env).includes(String(raw).toLowerCase());
  const cors = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Train-Sync-Key, X-Train-Client',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin, X-Train-Client',
  };
  if (match) cors['Access-Control-Allow-Origin'] = raw;
  return cors;
}

// ---- WRITER CHECK: the mirror's own guard for "one writer, always" ----------------------
// writer.json on GitHub Pages names the app that may write to the mirror ('pwa' until the
// native cutover, 'native' after it; rollback flips it back). Each request names its client
// with X-Train-Client ('pwa' or 'native'; a missing header counts as 'pwa', so a PWA that
// predates the header keeps syncing). The flag is read per invocation and cached 60 seconds
// per instance; the cache expires on time whether or not a refresh succeeds. With no
// unexpired value and no readable flag (404, invalid body, unreachable after three tries of
// 500 ms) the function fails closed: 503 'writer unknown', no Notion call, the client retries
// later. The other app gets 403 'not the writer', also before any Notion call. writer.json is
// committed as 'pwa' before this code deploys, so the first real request already finds it.
export const WRITER_FLAG_URL = 'https://hyndesyte.github.io/train/writer.json';
export const WRITER_CACHE_MS = 60_000;
export const WRITER_FETCH_TIMEOUT_MS = 500;
export const WRITER_FETCH_TRIES = 3;
const WRITERS = new Set(['pwa', 'native']);
let writerCache = { value: null, expiresAt: 0 };
export function resetWriterCache() { writerCache = { value: null, expiresAt: 0 }; }

export function clientOf(event) {
  const h = event.headers || {};
  const raw = h['x-train-client'] ?? h['X-Train-Client'];
  if (raw === undefined || raw === null || String(raw).trim() === '') return 'pwa';
  return String(raw).trim().toLowerCase();
}

// Returns 'pwa' | 'native' | null (unknown). fetchImpl and now are injectable for tests.
export async function currentWriter({ fetchImpl, now } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const clock = now || Date.now;
  if (writerCache.value && clock() < writerCache.expiresAt) return writerCache.value;
  for (let attempt = 0; attempt < WRITER_FETCH_TRIES; attempt++) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    // The timer both aborts the request and settles the race, so a fetch that ignores the
    // signal still cannot hold the invocation past the deadline.
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { try { if (ctl) ctl.abort(); } catch { /* ignore */ } reject(new Error('writer flag timeout')); }, WRITER_FETCH_TIMEOUT_MS); });
    const read = (async () => {
      const res = await f(`${WRITER_FLAG_URL}?t=${clock()}`, { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
      if (!res || !res.ok) return null;
      const body = await res.json();
      const value = body && typeof body.writer === 'string' ? body.writer.toLowerCase() : null;
      return WRITERS.has(value) ? value : null;
    })();
    try {
      const value = await Promise.race([read, deadline]);
      if (value) {
        writerCache = { value, expiresAt: clock() + WRITER_CACHE_MS };
        return value;
      }
    } catch { /* retry */ } finally { clearTimeout(timer); read.catch(() => {}); }
  }
  return null;
}

export const handler = async (event) => {
  const cors = corsHeaders(event);
  const json = (statusCode, obj, extraHeaders) => ({
    statusCode,
    headers: { ...cors, 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    body: JSON.stringify(obj),
  });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method not allowed' });

  // Optional shared-secret gate. Blocks casual noise against a public endpoint; because the key
  // ships in a public PWA it is NOT real auth against a motivated attacker (accepted tradeoff).
  const requiredSecret = process.env.TRAIN_SYNC_SECRET;
  if (requiredSecret) {
    const provided = event.headers['x-train-sync-key'] || event.headers['X-Train-Sync-Key'];
    if (provided !== requiredSecret) return json(401, { ok: false, error: 'unauthorized' });
  }

  const token = process.env.NOTION_TOKEN;
  const dataSourceId = process.env.NOTION_DATA_SOURCE_ID;
  if (!token || !dataSourceId) return json(500, { ok: false, error: 'server not configured' });

  if (!withinSizeLimit(event.body)) return json(413, { ok: false, error: 'payload too large' });

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return json(400, { ok: false, error: 'invalid JSON' });
  }

  const v = validatePayload(body);
  if (!v.ok) return json(400, { ok: false, error: v.error });

  // One writer: decided before any Notion call. Unknown fails closed; the other app is refused.
  const client = clientOf(event);
  const writer = await currentWriter();
  if (!writer) return json(503, { ok: false, error: 'writer unknown' }, { 'Retry-After': '60' });
  if (client !== writer) return json(403, { ok: false, error: 'not the writer', writer });

  const nowISO = new Date().toISOString();
  const notion = notionClient(token);

  try {
    const existing = await notion.queryBySessionId(dataSourceId, body.sessionId);

    if (v.op === 'delete') {
      if (!existing) return json(200, { ok: true, action: 'noop-absent', sessionId: body.sessionId });
      await notion.updatePage(existing, {
        Deleted: { checkbox: true },
        'Synced At': { date: { start: nowISO } },
      });
      return json(200, { ok: true, action: 'soft-deleted', notionPageId: existing, sessionId: body.sessionId });
    }

    const properties = toNotionProperties(body, nowISO);
    if (existing) {
      // Self-healing path: update properties only. The body blocks were written on the
      // original create (sessions are immutable after finalize except the Deleted tombstone).
      // Delete wins: an update never touches Deleted, so a stale re-post cannot resurrect a
      // tombstone (the PWA never un-deletes a session).
      delete properties.Deleted;
      await notion.updatePage(existing, properties);
      return json(200, { ok: true, action: 'updated', notionPageId: existing, sessionId: body.sessionId });
    }

    const children = toNotionChildren(body);
    const pageId = await notion.createPage(dataSourceId, properties, children);
    return json(200, { ok: true, action: 'created', notionPageId: pageId, sessionId: body.sessionId });
  } catch (err) {
    // Never echo secrets or full note bodies into logs.
    console.error('sync-training-session error:', err && err.message ? err.message : 'unknown');
    return json(502, { ok: false, error: 'notion request failed' });
  }
};

function notionClient(token) {
  const base = 'https://api.notion.com/v1';
  const headers = {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
  return {
    async queryBySessionId(dataSourceId, sessionId) {
      const res = await fetch(`${base}/data_sources/${dataSourceId}/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          filter: { property: 'Session ID', rich_text: { equals: sessionId } },
          page_size: 1,
        }),
      });
      if (!res.ok) throw new Error(`query ${res.status}`);
      const data = await res.json();
      return data.results && data.results.length ? data.results[0].id : null;
    },
    async createPage(dataSourceId, properties, children) {
      const res = await fetch(`${base}/pages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          parent: { type: 'data_source_id', data_source_id: dataSourceId },
          properties,
          children,
        }),
      });
      if (!res.ok) throw new Error(`create ${res.status}`);
      const data = await res.json();
      return data.id;
    },
    async updatePage(pageId, properties) {
      const res = await fetch(`${base}/pages/${pageId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ properties }),
      });
      if (!res.ok) throw new Error(`update ${res.status}`);
      return true;
    },
  };
}
