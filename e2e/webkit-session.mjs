// End-to-end run in a real WebKit at iPhone size (plan v3, R0 "WebKit run"): a fresh install
// runs one normal rotation session (Start Today) through Form, stations and the fork to Complete.
// The sync call is stubbed at the network layer (nothing reaches Netlify or Notion); the clock is
// faked so timers run instantly and the local day is a known Eastern evening. Asserts: no
// console/page errors, the entry is logged with the local date in normal mode, its sync payload
// is captured by the stub, History shows it, Settings carries no recovery or cardiology rows.
//   node e2e/webkit-session.mjs            (WebKit; E2E_BROWSER=chromium for a local dry run)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const browserName = process.env.E2E_BROWSER || 'webkit';
const SYNC_HOST = 'hyndesyte-train-sync.netlify.app';
const WRITER_HOST = 'hyndesyte.github.io';
const EVENING = new Date('2026-10-18T20:30:00-04:00');   // 8:30 PM EDT = 00:30Z next day
const LOCAL_DAY = '2026-10-18';

const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = join(root, p);
    await stat(f);
    res.writeHead(200, { 'Content-Type': types[extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(f));
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const problems = [];
const synced = [];
const failures = [];
const log = (...a) => console.log('[e2e]', ...a);
const fail = (msg) => { failures.push(msg); console.error('[e2e] FAIL', msg); };
const expect = (cond, msg) => { if (!cond) fail(msg); };

const browser = await (browserName === 'chromium' ? chromium : webkit).launch();
try {
  const device = devices['iPhone 15'] || devices['iPhone 14'] || devices['iPhone 13'];
  const context = await browser.newContext({ ...device, timezoneId: 'America/New_York', locale: 'en-US' });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + String(e)));
  page.on('requestfailed', (r) => { if (r.url().startsWith(base)) problems.push('requestfailed: ' + r.url()); });

  // One writer: the sync endpoint is a stub. Nothing leaves this process.
  await page.route(`https://${SYNC_HOST}/**`, async (route) => {
    const req = route.request();
    const corsHeaders = { 'Access-Control-Allow-Origin': new URL(base).origin, 'Access-Control-Allow-Headers': 'Content-Type, X-Train-Sync-Key, X-Train-Client', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    // The X-Train-Client header makes every post a preflighted request: answer OPTIONS, count POSTs.
    if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: corsHeaders, body: '' }); return; }
    let body = null;
    try { body = JSON.parse(req.postData() || 'null'); } catch { body = { unparsable: req.postData() }; }
    const client = req.headers()['x-train-client'];
    synced.push({ method: req.method(), body, client });
    await route.fulfill({ status: 200, contentType: 'application/json', headers: corsHeaders,
      body: JSON.stringify({ ok: true, action: 'created', notionPageId: 'stub-' + synced.length, sessionId: body && body.sessionId }) });
  });
  // The hand-off backstop reads writer.json on a fresh install: stub it as 'pwa' (the live file says
  // the same until cutover), and count the reads.
  const writerReads = [];
  await page.route(`https://${WRITER_HOST}/train/writer.json**`, async (route) => {
    writerReads.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ writer: 'pwa' }) });
  });
  // Any other third-party request (YouTube thumbnails etc.) is cut off: offline-safe run.
  await page.route((url) => !url.href.startsWith(base) && url.host !== SYNC_HOST && url.host !== WRITER_HOST, (route) => route.abort());

  await page.clock.install({ time: EVENING });
  await page.goto(base + 'index.html', { waitUntil: 'load' });
  const tick = async (ms = 1000) => { await page.clock.runFor(ms); };
  const btn = (name) => page.getByRole('button', { name, exact: false });
  const clickBtn = async (name) => { const b = btn(name).first(); await b.waitFor({ state: 'visible', timeout: 5000 }); await b.click(); await page.waitForTimeout(30); };
  const text = async (sel) => (await page.locator(sel).innerText()).replace(/\s+/g, ' ').trim();

  // ---- 0. Fresh install: the hand-off backstop read writer.json once (no state, no flag) and found
  // 'pwa', so Home is writable; Settings carries the hand-off row and the count-and-digest line.
  expect((await text('#home-content')).length > 20, 'Home renders');
  // The backstop's answer arrives through the stubbed route after DOMContentLoaded; page timers are
  // under the installed clock, so wait from this side with real time.
  const settle = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return fn(); };
  expect(await settle(() => page.evaluate(() => localStorage.getItem('train_handoff') === 'off')), 'flag written as off after the backstop');
  expect(writerReads.length === 1 && /writer\.json\?t=\d+/.test(writerReads[0]), 'one cache-busted writer.json read: ' + JSON.stringify(writerReads));
  expect(await settle(() => page.evaluate(() => /Start Today/.test(document.getElementById('home-content').innerText))), 'Home is writable after the backstop');
  await clickBtn('Settings');
  expect(!/Recovery mode|ardiology/.test(await text('#settings-content')), 'Settings has no recovery or cardiology rows');
  expect((await text('#settings-content')).includes('Hand off to the Train app'), 'Settings has the hand-off row');
  const digest0 = await page.evaluate(() => sessionDigest(getState()));
  expect(/^[0-9a-f]{8}$/.test(digest0), 'digest computes in the page: ' + digest0);
  await page.waitForTimeout(50);
  expect((await text('#session-digest')).includes('0 sessions') && (await text('#session-digest')).includes(digest0), 'digest line shows: ' + (await text('#session-digest')));
  await clickBtn('Today');
  expect(/Start Today/.test(await text('#home-content')), 'Home offers Start Today');

  // ---- 1. One normal ring session, Start -> Form -> stations -> fork -> Complete.
  await clickBtn("Start Today");
  expect(await page.locator('#screen-session.active').count() === 1, 'session screen open');
  const sessionType = await page.evaluate(() => AS && AS.type);
  const mode = await page.evaluate(() => AS && AS.mode);
  log('ring session', sessionType, mode);
  expect(mode !== 'recovery', 'session runs in normal mode, got ' + mode);
  for (let guard = 0; guard < 200; guard++) {
    const st = await page.evaluate(() => {
      if (!AS) return { done: true };
      const flow = currentFlow(); const s = flow[AS.cursor];
      return { phase: AS.phase, kind: s && s.kind, exId: s && s.exId, cursor: AS.cursor, len: flow.length, timer: !!AS.timerEnd, unit: s && s.exId && EXERCISE_LIBRARY[s.exId] ? EXERCISE_LIBRARY[s.exId].unit : null };
    });
    if (process.env.E2E_DEBUG) log('station', guard, JSON.stringify(st));
    if (st.done) break;
    if (st.phase === 'coreFork') { await clickBtn('Finish'); continue; }
    if (st.phase === 'restComplete') { await clickBtn('Start Next Set'); continue; }
    if (st.phase === 'rest') { await tick(200 * 1000); await page.waitForTimeout(20); continue; }
    if (st.phase === 'work') { await tick(120 * 1000); await page.waitForTimeout(20); continue; }
    if (st.kind === 'form' || st.kind === 'activation') {
      const b = page.locator('#screen-session button.btn-primary').first();
      await b.click(); await page.waitForTimeout(20); continue;
    }
    if (st.kind === 'exercise') {
      const hold = page.getByRole('button', { name: 'Start hold' });
      if (await hold.count()) { await hold.first().click(); await tick(120 * 1000); await page.waitForTimeout(20); continue; }
      const input = page.locator('#rep-input');
      if (await input.count()) { await input.fill('5'); await clickBtn('Log set'); continue; }
      const next = page.locator('#screen-session button.btn-primary').first();
      if (await next.count()) { await next.click(); await page.waitForTimeout(20); continue; }
    }
    if (st.kind === 'finish' || st.kind === 'summary' || (await page.getByRole('button', { name: 'Complete Session' }).count())) {
      await clickBtn('Complete Session'); continue;
    }
    // Unknown station: press the primary button if there is one, else fail.
    const any = page.locator('#screen-session button.btn-primary').first();
    if (await any.count()) { await any.click(); await page.waitForTimeout(20); continue; }
    fail('stuck at ' + JSON.stringify(st)); break;
  }
  const afterRing = await page.evaluate(() => ({ screen: currentScreen, as: !!AS, log: getState().log.map((e) => ({ type: e.sessionType, date: e.date, status: e.sessionStatus, core: e.coreComplete, mode: e.mode })) }));
  log('after ring', JSON.stringify(afterRing));
  expect(afterRing.log.length === 1, 'ring entry logged');
  const ring = afterRing.log[0] || {};
  expect(ring.date === LOCAL_DAY, 'ring entry dated the local day ' + ring.date);
  expect(ring.mode !== 'recovery', 'ring entry in normal mode');
  expect(ring.status === 'completed' || ring.status === 'partial', 'ring entry has a status: ' + ring.status);
  await tick(2000); await page.waitForTimeout(100);
  expect(synced.length >= 1, 'ring entry reached the (stubbed) sync endpoint');
  expect(synced[synced.length - 1].client === 'pwa', 'sync post names the client: ' + synced[synced.length - 1].client);
  const ringPayload = synced[synced.length - 1].body || {};
  expect(ringPayload.date === LOCAL_DAY && ringPayload.mode !== 'Recovery', 'ring sync payload: ' + JSON.stringify({ date: ringPayload.date, mode: ringPayload.mode, type: ringPayload.sessionType, status: ringPayload.status }));

  // ---- 2. History shows it, dated the local day; Settings build line present.
  await clickBtn('History');
  const hist = await text('#history-content');
  expect(hist.length > 40, 'History lists the entry');
  await clickBtn('Settings');
  const settings = await text('#settings-content');
  expect(/Build: v\d/.test(settings) && /1 session/.test(settings), 'Settings shows the build line and 1 session');
  await context.close();
} catch (e) {
  fail('exception: ' + (e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (problems.length) failures.push(...problems);
const ok = failures.length === 0;
console.log(JSON.stringify({ ok, browser: browserName, synced: synced.length, failures }, null, 1));
process.exit(ok ? 0 : 1);
