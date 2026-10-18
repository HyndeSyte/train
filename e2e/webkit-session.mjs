// End-to-end run in a real WebKit at iPhone size (plan v3, R0 "WebKit run"): a fresh install
// turns recovery mode on, runs PT's list through the guided timer to Finish, then runs one
// recovery ring session to Complete. The sync call is stubbed at the network layer (nothing
// reaches Netlify or Notion); the clock is faked so timers run instantly and the local day is a
// known Eastern evening. Asserts: no console/page errors, both entries logged with the local
// date, both sync payloads captured by the stub, History shows them, PT's list marks "done today".
//   node e2e/webkit-session.mjs            (WebKit; E2E_BROWSER=chromium for a local dry run)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, chromium, devices } from 'playwright';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const browserName = process.env.E2E_BROWSER || 'webkit';
const SYNC_HOST = 'hyndesyte-train-sync.netlify.app';
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
    let body = null;
    try { body = JSON.parse(req.postData() || 'null'); } catch { body = { unparsable: req.postData() }; }
    synced.push({ method: req.method(), body });
    await route.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': new URL(base).origin, 'Access-Control-Allow-Headers': 'Content-Type, X-Train-Sync-Key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' },
      body: JSON.stringify({ ok: true, action: 'created', notionPageId: 'stub-' + synced.length, sessionId: body && body.sessionId }) });
  });
  // Any other third-party request (YouTube thumbnails etc.) is cut off: offline-safe run.
  await page.route((url) => !url.href.startsWith(base) && url.host !== SYNC_HOST, (route) => route.abort());

  await page.clock.install({ time: EVENING });
  await page.goto(base + 'index.html', { waitUntil: 'load' });
  const tick = async (ms = 1000) => { await page.clock.runFor(ms); };
  const btn = (name) => page.getByRole('button', { name, exact: false });
  const clickBtn = async (name) => { const b = btn(name).first(); await b.waitFor({ state: 'visible', timeout: 5000 }); await b.click(); await page.waitForTimeout(30); };
  const text = async (sel) => (await page.locator(sel).innerText()).replace(/\s+/g, ' ').trim();

  // ---- 0. Fresh install: Home renders; turn recovery mode on from Settings (as on his phone).
  expect((await text('#home-content')).length > 20, 'Home renders');
  await clickBtn('Settings');
  expect((await text('#settings-content')).includes('Recovery mode'), 'Settings has the recovery row');
  const recRow = page.locator('.setting-row', { hasText: 'Recovery mode' }).first();
  await recRow.getByRole('button').first().click();
  expect((await text('#modal-title')).includes('Turn on recovery mode'), 'recovery confirm modal');
  await clickBtn('Turn on');
  await clickBtn('Today');
  const home = await text('#home-content');
  expect(/PT/.test(home) && /Start PT/.test(home), 'Home offers PT’s list in recovery mode: ' + home.slice(0, 120));

  // ---- 1. PT's list, guided, through the timer, to Finish.
  await clickBtn('Start PT');
  expect((await text('#modal-title')) === 'Arm check', 'arm check asked at the first session of the day');
  await clickBtn('Same');
  expect(await page.locator('#screen-pt.active').count() === 1, 'PT screen open');
  const ptItems = await page.evaluate(() => ptItemsAll().map((it) => ({ name: it.name, block: it.block || 'pt' })));
  const ptCount = ptItems.filter((it) => it.block === 'pt').length;
  expect(ptCount === 7, 'PT program has 7 items, got ' + ptCount);
  await clickBtn('Start with');                      // opens the first open item (the breathing opener)
  // Drive every item: tap Start, then let the fake clock run the holds/rests; tap Set done for rep sets.
  let driven = 0;
  for (let guard = 0; guard < 40; guard++) {
    const onItem = await page.locator('#pt-content').evaluate((el) => /One tap starts it/.test(el.innerText));
    if (!onItem) break;
    await clickBtn('Start');
    driven++;
    for (let g2 = 0; g2 < 400; g2++) {
      const state = await page.evaluate(() => PTS && PTS.run && PTS.run.plan ? (PTS.run.plan[PTS.run.k] && PTS.run.plan[PTS.run.k].kind) : null);
      if (!state) break;                                  // item finished -> next item's idle screen or the list
      if (state === 'reps') await clickBtn('Set done');
      else await tick(1000);
    }
    const backOnList = await page.locator('#pt-content').evaluate((el) => /PT’s program/.test(el.innerText) && !/One tap starts it/.test(el.innerText));
    if (backOnList) break;
  }
  const statuses = await page.evaluate(() => Object.assign({}, PTS.status));
  const doneCount = Object.values(statuses).filter((s) => s === 'done').length;
  log('PT items driven', driven, 'done', doneCount, 'of', ptItems.length);
  expect(doneCount >= ptCount, 'every PT program item done (' + doneCount + ')');
  // Train adds are optional; whatever is left open stays open. Finish from the list.
  if (!(await page.locator('#pt-content').evaluate((el) => /Finish/.test(el.innerText)))) await clickBtn('The list');
  await page.locator('#pt-note').fill('e2e run');
  await clickBtn('Finish');
  await page.waitForTimeout(50);
  const afterPt = await page.evaluate(() => ({ screen: currentScreen, log: getState().log.map((e) => ({ type: e.sessionType, date: e.date, status: e.sessionStatus, ptList: !!e.ptList, mode: e.mode, items: (e.ptItems || []).length })) }));
  log('after PT', JSON.stringify(afterPt));
  expect(afterPt.log.length === 1 && afterPt.log[0].type === 'PT', 'one PT entry logged');
  expect(afterPt.log[0].date === LOCAL_DAY, 'PT entry dated the local day ' + afterPt.log[0].date);
  expect(afterPt.log[0].status === 'completed', 'PT list completed');
  expect(afterPt.log[0].items === ptItems.length, 'per-item statuses logged');
  await tick(2000);                                       // let the fire-and-forget sync run
  await page.waitForTimeout(100);
  expect(synced.length >= 1, 'PT entry reached the (stubbed) sync endpoint');
  const ptPayload = synced[synced.length - 1].body || {};
  expect(ptPayload.date === LOCAL_DAY && ptPayload.ptList === true && ptPayload.mode === 'Recovery', 'PT sync payload carries date/ptList/mode: ' + JSON.stringify({ date: ptPayload.date, ptList: ptPayload.ptList, mode: ptPayload.mode, status: ptPayload.status }));
  expect(/done today|Open the list again|Logged today/i.test(await text('#home-content')), 'Home marks PT’s list done today');

  // ---- 2. One recovery ring session, Start -> Form -> stations -> fork -> Complete.
  await clickBtn("Start Today");
  expect(await page.locator('#screen-session.active').count() === 1, 'session screen open');
  const sessionType = await page.evaluate(() => AS && AS.type);
  const mode = await page.evaluate(() => AS && AS.mode);
  log('ring session', sessionType, mode);
  expect(mode === 'recovery', 'session runs in recovery mode');
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
  expect(afterRing.log.length === 2, 'ring entry logged');
  const ring = afterRing.log[1] || {};
  expect(ring.date === LOCAL_DAY, 'ring entry dated the local day ' + ring.date);
  expect(ring.mode === 'recovery', 'ring entry in recovery mode');
  expect(ring.status === 'completed' || ring.status === 'partial', 'ring entry has a status: ' + ring.status);
  await tick(2000); await page.waitForTimeout(100);
  expect(synced.length >= 2, 'ring entry reached the (stubbed) sync endpoint');
  const ringPayload = synced[synced.length - 1].body || {};
  expect(ringPayload.date === LOCAL_DAY && ringPayload.mode === 'Recovery', 'ring sync payload: ' + JSON.stringify({ date: ringPayload.date, mode: ringPayload.mode, type: ringPayload.sessionType, status: ringPayload.status }));

  // ---- 3. History shows both, dated the local day; Settings build line present.
  await clickBtn('History');
  const hist = await text('#history-content');
  expect(hist.includes('PT') && hist.length > 40, 'History lists the entries');
  await clickBtn('Settings');
  const settings = await text('#settings-content');
  expect(/Build: v\d/.test(settings) && /2 sessions/.test(settings), 'Settings shows the build line and 2 sessions');
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
