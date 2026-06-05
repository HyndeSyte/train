// Netlify Function (v1 classic handler): Train PWA -> Notion "Training - Session Log".
// Idempotent upsert keyed by Session ID. Holds NOTION_TOKEN server-side; the PWA never sees it.
//
// Env vars (set in Netlify site settings -- NEVER committed to this repo):
//   NOTION_TOKEN           Notion internal integration secret
//   NOTION_DATA_SOURCE_ID  data source ID of "Training - Session Log" (bb53c37f-...)
//   TRAIN_SYNC_SECRET      optional shared key; if set, requests must send matching X-Train-Sync-Key
//   ALLOWED_ORIGIN         optional; defaults to the GitHub Pages origin below
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
const DEFAULT_ORIGIN = 'https://hyndesyte.github.io';

export const handler = async (event) => {
  const origin = process.env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
  const cors = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Train-Sync-Key',
    'Access-Control-Max-Age': '86400',
  };
  const json = (statusCode, obj) => ({
    statusCode,
    headers: { ...cors, 'Content-Type': 'application/json' },
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
