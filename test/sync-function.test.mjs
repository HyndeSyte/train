// Handler-level tests for the Netlify sync function: CORS allowlist (echo + Vary), the
// idempotent re-post, and the delete tombstone. Notion is a fake fetch; nothing leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handler, corsHeaders, allowedOrigins, currentWriter, clientOf, resetWriterCache, WRITER_FLAG_URL, WRITER_CACHE_MS, WRITER_FETCH_TRIES } from '../netlify/functions/sync-training-session.mjs';

const PAGES = 'https://hyndesyte.github.io';
const SHELL = 'capacitor://localhost';

// writer: 'pwa' | 'native' | '404' | 'malformed' | 'down' | a function (url) => response (per call)
function fakeNotion(seedRows = {}, writer = 'pwa') {
  // rows: sessionId -> { id, properties }
  const rows = new Map(Object.entries(seedRows));
  const calls = [];
  const flagReads = [];
  let n = 0;
  resetWriterCache();
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(WRITER_FLAG_URL)) {
      flagReads.push(String(url));
      const w = typeof writer === 'function' ? writer(url, flagReads.length) : writer;
      if (w === 'down') throw new Error('ECONNREFUSED');
      if (w === '404') return { ok: false, status: 404, json: async () => ({}) };
      if (w === 'malformed') return { ok: true, status: 200, json: async () => ({ writer: 'both' }) };
      if (w === 'badjson') return { ok: true, status: 200, json: async () => { throw new Error('bad json'); } };
      return { ok: true, status: 200, json: async () => ({ writer: w }) };
    }
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, body });
    if (url.endsWith('/query')) {
      const sid = body.filter.rich_text.equals;
      const row = rows.get(sid);
      return { ok: true, json: async () => ({ results: row ? [{ id: row.id }] : [] }) };
    }
    if (url.endsWith('/pages') && init.method === 'POST') {
      const id = `page-${++n}`;
      const sid = body.properties['Session ID'].rich_text[0].text.content;
      rows.set(sid, { id, properties: body.properties, children: body.children });
      return { ok: true, json: async () => ({ id }) };
    }
    if (/\/pages\/[^/]+$/.test(url) && init.method === 'PATCH') {
      const id = url.split('/').pop();
      for (const row of rows.values()) if (row.id === id) row.properties = { ...row.properties, ...body.properties };
      return { ok: true, json: async () => ({ id }) };
    }
    throw new Error('unexpected fetch ' + init.method + ' ' + url);
  };
  return { rows, calls, flagReads };
}

function env(extra = {}) {
  process.env.NOTION_TOKEN = 'secret-token';
  process.env.NOTION_DATA_SOURCE_ID = 'ds-1';
  delete process.env.TRAIN_SYNC_SECRET;
  delete process.env.ALLOWED_ORIGIN;
  Object.assign(process.env, extra);
}

const payload = (over = {}) => ({
  op: 'upsert', sessionId: 'sid-0001', sessionSequence: 1, date: '2026-10-18',
  completedAt: '2026-10-19T00:30:00.000Z', sessionType: 'PT', status: 'Completed', durationMin: 6,
  overrideUsed: false, sessionNote: '', issueCount: 0, issueFlags: [], attentionFlag: false,
  mode: 'Recovery', armCheck: 'Same', ptList: true, coreComplete: true, ...over,
});

const req = (method, body, origin, headers = {}) => ({
  httpMethod: method,
  headers: { ...(origin ? { origin } : {}), ...headers },
  body: body == null ? '' : JSON.stringify(body),
});

test('allowlist: Pages and the Capacitor shell, plus ALLOWED_ORIGIN extras, matched case-insensitively', () => {
  assert.deepEqual(allowedOrigins({}), [PAGES, SHELL]);
  assert.deepEqual(allowedOrigins({ ALLOWED_ORIGIN: 'https://Example.test, https://two.test' }), [PAGES, SHELL, 'https://example.test', 'https://two.test']);
  const h = corsHeaders({ headers: { Origin: 'https://HyndeSyte.github.io' } }, {});
  assert.equal(h['Access-Control-Allow-Origin'], 'https://HyndeSyte.github.io', 'echoes the request Origin as sent');
  assert.equal(h.Vary, 'Origin, X-Train-Client');
  const shell = corsHeaders({ headers: { origin: SHELL } }, {});
  assert.equal(shell['Access-Control-Allow-Origin'], SHELL);
  const other = corsHeaders({ headers: { origin: 'https://evil.example' } }, {});
  assert.equal('Access-Control-Allow-Origin' in other, false, 'no ACAO for an unlisted origin');
  assert.equal(other.Vary, 'Origin, X-Train-Client');
  const none = corsHeaders({ headers: {} }, {});
  assert.equal('Access-Control-Allow-Origin' in none, false, 'no ACAO without an Origin');
});

test('OPTIONS preflight: 204 with the echoed origin on POST and OPTIONS; unlisted origin gets no ACAO', async () => {
  env(); fakeNotion();
  let r = await handler(req('OPTIONS', null, SHELL));
  assert.equal(r.statusCode, 204);
  assert.equal(r.headers['Access-Control-Allow-Origin'], SHELL);
  assert.equal(r.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
  assert.equal(r.headers.Vary, 'Origin, X-Train-Client');
  r = await handler(req('OPTIONS', null, 'https://evil.example'));
  assert.equal(r.statusCode, 204);
  assert.equal('Access-Control-Allow-Origin' in r.headers, false);
  // POST carries the same headers (incl. on error responses)
  r = await handler(req('GET', null, PAGES));
  assert.equal(r.statusCode, 405);
  assert.equal(r.headers['Access-Control-Allow-Origin'], PAGES);
  assert.equal(r.headers.Vary, 'Origin, X-Train-Client');
});

test('upsert: first post creates; a re-post of the same Session ID updates the row, never a second create', async () => {
  env(); const n = fakeNotion();
  let r = await handler(req('POST', payload(), PAGES));
  assert.equal(r.statusCode, 200);
  let body = JSON.parse(r.body);
  assert.equal(body.action, 'created');
  assert.equal(r.headers['Access-Control-Allow-Origin'], PAGES);
  assert.equal(n.rows.size, 1);
  const pageId = n.rows.get('sid-0001').id;

  r = await handler(req('POST', payload({ sessionNote: 'second push after a timeout' }), SHELL));
  body = JSON.parse(r.body);
  assert.equal(r.statusCode, 200);
  assert.equal(body.action, 'updated');
  assert.equal(body.notionPageId, pageId);
  assert.equal(r.headers['Access-Control-Allow-Origin'], SHELL, 'the shell origin is echoed too');
  assert.equal(n.rows.size, 1, 'still one row');
  assert.equal(n.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/pages')).length, 1, 'exactly one create');
  assert.equal(n.calls.filter((c) => c.method === 'PATCH').length, 1, 'the re-post patched');
  assert.equal(n.rows.get('sid-0001').properties['Session Note'].rich_text[0].text.content, 'second push after a timeout');
});

test('delete: soft-deletes an existing row (Deleted + Synced At), noop when absent, never creates', async () => {
  env(); const n = fakeNotion();
  await handler(req('POST', payload(), PAGES));
  let r = await handler(req('POST', { op: 'delete', sessionId: 'sid-0001' }, PAGES));
  let body = JSON.parse(r.body);
  assert.equal(r.statusCode, 200);
  assert.equal(body.action, 'soft-deleted');
  const row = n.rows.get('sid-0001');
  assert.equal(row.properties.Deleted.checkbox, true);
  assert.ok(row.properties['Synced At'].date.start);
  assert.equal(n.rows.size, 1, 'row kept as a tombstone');

  r = await handler(req('POST', { op: 'delete', sessionId: 'never-existed' }, PAGES));
  body = JSON.parse(r.body);
  assert.equal(body.action, 'noop-absent');
  assert.equal(n.rows.size, 1, 'nothing created by a delete');
});

test('delete wins: a stale re-post after a delete leaves the tombstone in place', async () => {
  env(); const n = fakeNotion();
  await handler(req('POST', payload(), PAGES));
  await handler(req('POST', { op: 'delete', sessionId: 'sid-0001' }, PAGES));
  const r = await handler(req('POST', payload({ sessionNote: 'late retry from a stale client' }), PAGES));
  assert.equal(JSON.parse(r.body).action, 'updated');
  const row = n.rows.get('sid-0001');
  assert.equal(row.properties.Deleted.checkbox, true, 'tombstone kept');
  assert.equal(row.properties['Session Note'].rich_text[0].text.content, 'late retry from a stale client');
  const patch = n.calls.filter((c) => c.method === 'PATCH').pop();
  assert.equal('Deleted' in patch.body.properties, false, 'update never sends Deleted');
  // a first-time create still writes Deleted=false
  await handler(req('POST', payload({ sessionId: 'sid-0002' }), PAGES));
  assert.equal(n.rows.get('sid-0002').properties.Deleted.checkbox, false);
});

test('preflight allows the headers the clients send', async () => {
  env(); fakeNotion();
  const r = await handler(req('OPTIONS', null, SHELL));
  assert.equal(r.headers['Access-Control-Allow-Headers'], 'Content-Type, X-Train-Sync-Key, X-Train-Client');
  assert.equal(r.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
});

test('shared-secret gate still applies before any Notion call', async () => {
  env({ TRAIN_SYNC_SECRET: 'k' }); const n = fakeNotion();
  let r = await handler(req('POST', payload(), PAGES));
  assert.equal(r.statusCode, 401);
  assert.equal(n.calls.length, 0);
  r = await handler(req('POST', payload(), PAGES, { 'x-train-sync-key': 'k' }));
  assert.equal(r.statusCode, 200);
});

// ---- writer check -------------------------------------------------------------------------

const notionCalls = (n) => n.calls.length;   // Notion calls only (flag reads are counted apart)

test('writer check: the named writer is accepted, the other app refused before any Notion call; a missing header is the PWA', async () => {
  env(); let n = fakeNotion({}, 'pwa');
  let r = await handler(req('POST', payload(), PAGES, { 'x-train-client': 'pwa' }));
  assert.equal(r.statusCode, 200);
  r = await handler(req('POST', payload({ sessionId: 'sid-0002' }), PAGES));   // no header: counts as pwa
  assert.equal(r.statusCode, 200);
  const before = notionCalls(n);
  r = await handler(req('POST', payload({ sessionId: 'sid-0003' }), SHELL, { 'X-Train-Client': 'native' }));
  assert.equal(r.statusCode, 403);
  assert.deepEqual(JSON.parse(r.body), { ok: false, error: 'not the writer', writer: 'pwa' });
  assert.equal(r.headers.Vary, 'Origin, X-Train-Client');
  assert.equal(r.headers['Access-Control-Allow-Origin'], SHELL);
  assert.equal(notionCalls(n), before, '403 made no Notion call');
  assert.equal(n.flagReads.length, 1, 'the flag was read once and cached across the three requests');

  // after cutover the roles swap
  n = fakeNotion({}, 'native');
  r = await handler(req('POST', payload(), SHELL, { 'x-train-client': 'native' }));
  assert.equal(r.statusCode, 200);
  r = await handler(req('POST', payload({ sessionId: 'sid-0009' }), PAGES));
  assert.equal(r.statusCode, 403, 'the PWA (header or not) is refused once native is the writer');
  assert.equal(notionCalls(n), 2, 'only the accepted post touched Notion (query + create)');
  r = await handler(req('POST', { op: 'delete', sessionId: 'sid-0001' }, PAGES, { 'x-train-client': 'pwa' }));
  assert.equal(r.statusCode, 403, 'deletes are gated too');
  r = await handler(req('POST', payload({ sessionId: 'sid-0010' }), PAGES, { 'x-train-client': 'someone-else' }));
  assert.equal(r.statusCode, 403, 'an unrecognised client is not the writer');
});

test('writer check: a missing, malformed or unreachable flag fails closed with 503 and no Notion call', async () => {
  for (const w of ['404', 'malformed', 'badjson', 'down']) {
    env(); const n = fakeNotion({}, w);
    const r = await handler(req('POST', payload(), PAGES));
    assert.equal(r.statusCode, 503, w);
    assert.deepEqual(JSON.parse(r.body), { ok: false, error: 'writer unknown' });
    assert.equal(r.headers['Retry-After'], '60');
    assert.equal(r.headers.Vary, 'Origin, X-Train-Client');
    assert.equal(notionCalls(n), 0, w + ': no Notion call');
    assert.equal(n.flagReads.length, WRITER_FETCH_TRIES, w + ': three tries');
  }
});

test('writer check: a transient failure is recovered by the retry; a cold instance with Pages down stays closed', async () => {
  env(); let n = fakeNotion({}, (url, i) => (i === 1 ? 'down' : 'pwa'));
  let r = await handler(req('POST', payload(), PAGES));
  assert.equal(r.statusCode, 200);
  assert.equal(n.flagReads.length, 2, 'failed once, succeeded on the retry');
  // cold instance after cutover, Pages unreachable: never substitutes pwa
  n = fakeNotion({}, 'down');
  r = await handler(req('POST', payload(), PAGES));
  assert.equal(r.statusCode, 503);
  r = await handler(req('POST', payload(), SHELL, { 'x-train-client': 'native' }));
  assert.equal(r.statusCode, 503);
  assert.equal(notionCalls(n), 0);
});

test('writer check: the cache lives 60 seconds whether or not the refresh then succeeds', async () => {
  let t = 1_000_000;
  const now = () => t;
  resetWriterCache();
  let answers = ['pwa'];
  const f = async () => { const a = answers.shift(); if (a === 'down') throw new Error('down'); return { ok: true, json: async () => ({ writer: a }) }; };
  assert.equal(await currentWriter({ fetchImpl: f, now }), 'pwa');
  t += WRITER_CACHE_MS - 1;
  answers = ['native'];
  assert.equal(await currentWriter({ fetchImpl: f, now }), 'pwa', 'cached value within 60 s');
  t += 2;   // expired
  assert.equal(await currentWriter({ fetchImpl: f, now }), 'native', 'refreshed after expiry');
  t += WRITER_CACHE_MS + 1;
  answers = ['down', 'down', 'down'];
  assert.equal(await currentWriter({ fetchImpl: f, now }), null, 'an expired cache is not reused when the refresh fails');
  t += 1;
  answers = ['down', 'pwa'];
  assert.equal(await currentWriter({ fetchImpl: f, now }), 'pwa', 'a transient failure is retried');
});

test('writer check: reads are cache-busted and the client header is read case-insensitively', async () => {
  env(); const n = fakeNotion({}, 'pwa');
  await handler(req('POST', payload(), PAGES));
  assert.match(n.flagReads[0], /writer\.json\?t=\d+$/);
  assert.equal(clientOf({ headers: { 'X-Train-Client': ' Native ' } }), 'native');
  assert.equal(clientOf({ headers: {} }), 'pwa');
  assert.equal(clientOf({ headers: { 'x-train-client': '' } }), 'pwa');
});

test('writer check: a flag that never answers times out (500 ms a try, three tries) into 503', async () => {
  env(); const n = fakeNotion();
  globalThis.fetch = (url) => (String(url).startsWith(WRITER_FLAG_URL) ? new Promise(() => {}) : Promise.reject(new Error('unexpected')));
  const t0 = Date.now();
  const r = await handler(req('POST', payload(), PAGES));
  const elapsed = Date.now() - t0;
  assert.equal(r.statusCode, 503);
  assert.ok(elapsed >= 1400 && elapsed < 4000, 'bounded by the three timeouts: ' + elapsed + ' ms');
  assert.equal(n.calls.length, 0);
});
