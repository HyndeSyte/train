// The cutover build (plan v4, section 5): sync arming behind the native switch, the fingerprint and
// "verified", the forced-failure drill, the tombstone probe's shape, the count-and-digest fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, seedState, entry, committedBytes, sha256, sleep } from './shell-harness.mjs';
import { bootPwa } from './pwa-harness.mjs';

const same = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(5); return fn(); };
const seededWorld = (state = seedState(), rev = 3) => { const w = new World(); w.store.file = committedBytes(state, rev); w.store.rev = rev; w.store.generation = 1; return w; };
const pendingState = () => seedState({ log: [entry(1, { notionSync: { status: 'pending' } }), entry(2, { notionSync: { status: 'failed', error: 'x' } }), entry(3)], pendingDeletes: ['sid-0042-deleted'] });
const SYNC_URL = 'https://hyndesyte-train-sync.netlify.app/.netlify/functions/sync-training-session';
const ok = () => ({ status: 200, body: { ok: true, action: 'created', notionPageId: 'p1' } });

// drive one recovery ring session to Complete through the app's own functions
async function completeSession(page) {
  page.ctx.startSession('RP');
  if (page.modalTitle() === 'Arm check') await page.pressModal('Same');
  for (let guard = 0; guard < 60 && page.ctx.__AS(); guard++) {
    const as = page.ctx.__AS(); const flow = page.ctx.currentFlow(); const st = flow[as.cursor];
    if (!st) { page.ctx.finalizeSession('completed'); break; }
    if (as.phase === 'coreFork') { page.ctx.finishAtFork(); continue; }
    if (st.kind !== 'exercise') { page.ctx.advanceForm(); continue; }
    if (as.phase === 'rest' || as.phase === 'restPaused') { page.ctx.endRestNow(); continue; }
    if (as.phase === 'restComplete') { page.ctx.startNextAfterRest(); continue; }
    if (as.phase === 'work' || as.phase === 'workPaused') { page.ctx.finishDurationEarly(); continue; }
    const ex = page.ctx.EXERCISE_LIBRARY[st.exId];
    if (page.ctx.isDurationUnit(ex.unit)) { page.ctx.startDurationSet(); page.ctx.finishDurationEarly(); } else { page.ctx.logRepSet(); }
  }
  assert.equal(page.ctx.__AS(), null, 'the session finalized');
  const log = page.state().log; return log[log.length - 1];
}

// ---- 1. sync arming ---------------------------------------------------------------------------------

test('syncArmed off: zero posts with pending sessions and a tombstone seeded, through boot, finalize and Retry sync', async () => {
  const w = seededWorld(pendingState());
  w.syncResponder = ok;
  const page = await w.boot();
  await sleep(30);
  assert.equal(w.syncRequests.length, 0, 'boot posted nothing');
  assert.equal(page.ctx.__sync.armed, false);
  const last = await completeSession(page);
  await page.settle(); await sleep(30);
  assert.equal(w.syncRequests.length, 0, 'finalize posted nothing');
  assert.notEqual(last.notionSync && last.notionSync.status, 'synced');
  await page.ctx.pushUnsynced();                               // Retry sync
  assert.equal(w.syncRequests.length, 0, 'Retry sync posted nothing');
  same(await page.ctx.__syncNow(), { off: true });
  assert.match(page.modalTitle(), /Syncing is off/);
  assert.equal(w.syncRequests.length, 0);
  assert.match(page.settings(), /Start syncing from this app/);
  assert.match(page.settings(), /Sync now/);
  assert.equal(page.els['store-sync-switch'].textContent, 'Off');
});

test('the switch: a confirm turns syncing on, persisted through setSyncArmed; Sync now drains serially with X-Train-Client: native; turning off needs no confirm; a relaunch keeps the switch', async () => {
  const w = seededWorld(pendingState());
  let inflight = 0, maxInflight = 0;
  w.syncResponder = async () => { inflight++; maxInflight = Math.max(maxInflight, inflight); await sleep(15); inflight--; return ok(); };
  const page = await w.boot();
  page.settings();
  page.els['store-sync-switch'].onclick();
  assert.equal(page.modalTitle(), 'Start syncing from this app?');
  assert.match(page.modalBody(), /Only after the hand-off/);
  await page.pressModal('Turn on');
  assert.ok(await until(() => page.ctx.__sync.armed === true), 'armed');
  assert.equal(w.store.syncArmed, true, 'persisted in the control sidecar');
  assert.equal(page.els['store-sync-switch'].textContent, 'On');
  const r = await page.ctx.__syncNow();
  same(r, { posted: 3, stopped: null });
  // one request at a time, in order: the tombstone first, then the entries oldest-first
  assert.equal(maxInflight, 1, 'one request in flight at a time');
  same(w.syncRequests.map((q) => q.body.op || 'upsert'), ['delete', 'upsert', 'upsert']);
  same(w.syncRequests.map((q) => q.body.sessionId), ['sid-0042-deleted', 'sid-0001', 'sid-0002']);
  w.syncRequests.forEach((q) => { assert.equal(q.headers['X-Train-Client'], 'native'); assert.equal(q.headers['Content-Type'], 'application/json'); assert.equal(q.url, SYNC_URL); });
  await page.settle();
  const s = page.state();
  assert.equal(s.pendingDeletes.length, 0, 'the tombstone was drained');
  assert.ok(s.log.every((e) => e.notionSync && e.notionSync.status === 'synced'), 'every entry synced');
  assert.equal(s.log[0].notionSync.notionPageId, 'p1');
  // a finalize while armed posts (through the chain), a second finalize queues behind it
  const n = w.syncRequests.length;
  const last = await completeSession(page);
  assert.ok(await until(() => w.syncRequests.length === n + 1), 'finalize posted');
  assert.equal(w.syncRequests[n].body.sessionId, last.sessionId);
  await page.settle(); await sleep(40);
  assert.equal(page.state().log.find((e) => e.sessionId === last.sessionId).notionSync.status, 'synced');
  // off needs no confirm, and takes effect before the round trip
  page.settings();
  page.els['store-sync-switch'].onclick();
  assert.equal(page.ctx.__sync.armed, false, 'off at once');
  assert.ok(await until(() => w.store.syncArmed === false), 'then persisted');
  assert.notEqual(page.modalTitle(), 'Start syncing from this app?');
  // the persisted switch decides the next run: on again, then relaunch posts at boot; off, relaunch posts nothing
  await page.ctx.__setSyncArmed(true);
  w.evict(); w.store.file = committedBytes(pendingState(), w.store.rev); w.syncRequests = [];
  const again = await w.boot();
  assert.equal(again.ctx.__sync.armed, true, 'armed from the sidecar');
  assert.ok(await until(() => w.syncRequests.length === 3), 'boot drained the seeded pending items: ' + w.syncRequests.length);
  await again.ctx.__setSyncArmed(false);
  w.syncRequests = [];
  const third = await w.boot();
  await sleep(40);
  assert.equal(third.ctx.__sync.armed, false);
  assert.equal(w.syncRequests.length, 0, 'off: boot posted nothing');
});

test('403 ends the drain: the refused entry stays pending (not failed), the rest are not posted, the banner names it, and nothing re-posts until Sync now', async () => {
  const w = seededWorld(pendingState());
  w.store.syncArmed = true;
  let calls = 0;
  w.syncResponder = () => { calls++; return calls === 2 ? { status: 403, body: { ok: false, error: 'not the writer: pwa' } } : ok(); };
  const page = await w.boot();
  assert.ok(await until(() => w.syncRequests.length === 2 && page.banner()), 'two posts then the refusal');
  await sleep(40);
  assert.equal(w.syncRequests.length, 2, 'the drain stopped at the 403 (sid-0002 and nothing after)');
  assert.match(page.banner(), /sync refused: this app is not the writer; use Sync now once the hand-off is done/);
  const s = page.state();
  assert.equal(s.pendingDeletes.length, 0, 'the tombstone before it was drained');
  assert.equal(s.log[0].notionSync.status, 'pending', 'the refused entry stays pending');
  assert.match(s.log[0].notionSync.error, /not the writer/);
  assert.equal(s.log[1].notionSync.status, 'failed', 'the later entry was never attempted (as seeded)');
  assert.deepEqual(page.ctx.__sync.refused && page.ctx.__sync.refused.status, 403);
  assert.match(page.ctx.__sync.refused.body, /not the writer/);
  // a finalize after the refusal does not post automatically
  const last = await completeSession(page);
  await page.settle(); await sleep(40);
  assert.equal(w.syncRequests.length, 2, 'no automatic re-post after a refusal');
  assert.notEqual(page.state().log.find((e) => e.sessionId === last.sessionId).notionSync.status, 'synced');
  assert.ok(page.bridge.events.some((e) => e.syncSkipped === 'refused'));
  // Sync now starts a fresh drain once the hand-off is done
  w.syncResponder = ok;
  const r = await page.ctx.__syncNow();
  assert.equal(r.stopped, null);
  assert.equal(r.posted, 3, 'sid-0001, sid-0002 and the new session');
  assert.ok(page.state().log.every((e) => e.notionSync && e.notionSync.status === 'synced'));
});

test('503 is a plain retry: the entry is marked failed with the status, the drain goes on, and the next drain re-posts it', async () => {
  const w = seededWorld(pendingState());
  w.store.syncArmed = true;
  let calls = 0;
  w.syncResponder = () => { calls++; return calls === 2 ? { status: 503, body: 'try later' } : ok(); };
  const page = await w.boot();
  assert.ok(await until(() => w.syncRequests.length === 3), 'the drain went on past the 503');
  await page.settle();
  const s = page.state();
  assert.equal(s.log[0].notionSync.status, 'failed');
  assert.match(s.log[0].notionSync.error, /503/);
  assert.equal(s.log[1].notionSync.status, 'synced');
  assert.equal(page.banner(), null, 'no banner for a 503');
  const r = await page.ctx.__syncNow();
  assert.equal(r.posted, 1);
  assert.equal(page.state().log[0].notionSync.status, 'synced');
});

test('Import and Erase disarm: the switch shows off after the reload and only the switch re-arms; the quiescing guard still refuses a sync attempt during the drain', async () => {
  const w = seededWorld();
  w.store.syncArmed = true;
  w.syncResponder = ok;
  const page = await w.boot();
  await page.settle();
  assert.equal(page.ctx.__sync.armed, true);
  page.ctx.importData({ target: { files: [{ text: JSON.stringify(seedState({ log: [entry(7, { notionSync: { status: 'pending' } })] })) }] } });
  await sleep(5); await page.pressModal('Import');
  assert.ok(await until(() => w.reloads === 1));
  assert.equal(w.store.syncArmed, false);
  const again = await w.boot();
  assert.equal(again.ctx.__sync.armed, false, 'disarmed after the import');
  again.settings();
  assert.equal(again.els['store-sync-switch'].textContent, 'Off');
  await sleep(30);
  assert.equal(w.syncRequests.length, 0, 'the imported pending entry was not posted');
  // only the switch re-arms; arming alone posts nothing, Sync now drains with the switch on
  await again.ctx.__setSyncArmed(true);
  assert.equal(w.store.syncArmed, true);
  await sleep(30);
  assert.equal(w.syncRequests.length, 0, 'arming alone posts nothing');
  await again.ctx.__syncNow();
  assert.ok(w.syncRequests.length >= 1, 'armed again, Sync now posts');
  // Erase disarms too
  again.ctx.confirmErase(); await again.pressModal('Erase everything');
  assert.ok(await until(() => w.reloads === 2));
  assert.equal(w.store.syncArmed, false);
  const third = await w.boot();
  assert.equal(third.ctx.__sync.armed, false);
  // armed, with a request in flight: the guard refuses new sync starts during a transaction's drain
  await third.ctx.__setSyncArmed(true);
  third.ctx.__sync.inflight = 1;
  third.ctx.importData({ target: { files: [{ text: JSON.stringify(seedState({ log: [entry(8)] })) }] } });
  await sleep(5); await third.pressModal('Import');
  await sleep(5);
  assert.equal(third.ctx.__sync.quiescing, true);
  same(await third.ctx.pushUnsynced(), { refused: 'quiescing' });
  same(await third.ctx.syncEntry('sid-0008'), { refused: 'quiescing' });
  await assert.rejects(() => third.ctx.postSync({ op: 'delete', sessionId: 'x' }), /quiescing/);
  assert.ok(await until(() => third.modalTitle() === 'Still syncing'));
  third.ctx.__sync.inflight = 0;
});

// ---- 2. count, digest, fingerprint, verified ---------------------------------------------------------

test('count and digest: the fixture s-a, s-b, s-c is 3175a2eb; Settings shows it beside Export and for the kept snapshot', async () => {
  assert.equal(sha256(['s-a', 's-b', 's-c'].sort().join('\n')).slice(0, 8), '3175a2eb');
  const state = seedState({ log: [entry(1, { sessionId: 's-c' }), entry(2, { sessionId: 's-a' }), entry(3, { sessionId: 's-b' })] });
  const w = seededWorld(state);
  const page = await w.boot();
  page.settings();
  await sleep(20);
  assert.equal(page.els['store-loaded'].textContent, '3 sessions · digest 3175a2eb loaded');
  assert.match(page.els['settings-content'].innerHTML, /via the share sheet · 3 sessions · digest 3175a2eb/);
  // a kept snapshot shows its own count and digest beside its export button
  const other = JSON.parse(w.store.file); other.rotationIndex = 4; w.store.writeExternally(JSON.stringify(other));
  const again = await w.boot();
  assert.match(again.banner(), /3 sessions · digest 3175a2eb/);
  again.settings(); await sleep(20);
  assert.match(again.els['store-snapshot-line'].textContent, /^3 sessions · digest 3175a2eb · kept /);
  assert.match(again.settings(), /Export the saved snapshot/);
});

test('fingerprint: canonical JSON of the covered fields; any covered field changes it, excluded bookkeeping does not', async () => {
  const w = seededWorld();
  const page = await w.boot();
  const fp = page.ctx.__fingerprintOf;
  const base = seedState();
  const a = await fp(base);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(await fp(JSON.parse(JSON.stringify(base))), a, 'deterministic');
  // excluded: _rev, _base, seedRev, every notionSync
  const bookkeeping = JSON.parse(JSON.stringify(base)); bookkeeping._rev = 9; bookkeeping._base = 8; bookkeeping.seedRev = 7;
  bookkeeping.log[0].notionSync = { status: 'pending', error: 'x' }; delete bookkeeping.log[1].notionSync;
  assert.equal(await fp(bookkeeping), a, 'bookkeeping changes nothing');
  // key order does not matter
  const reordered = Object.fromEntries(Object.entries(base).reverse()); reordered.log = base.log.map((e) => Object.fromEntries(Object.entries(e).reverse()));
  assert.equal(await fp(reordered), a);
  // every covered field changes it
  const changes = {
    'log entry field': (s) => { s.log[1].duration = 99; },
    'log entry id': (s) => { s.log[0].sessionId = 'sid-9999'; },
    'log order': (s) => { s.log.reverse(); },
    pendingDeletes: (s) => { s.pendingDeletes = ['sid-0001']; },
    rotationIndex: (s) => { s.rotationIndex = 3; },
    nextSessionOverride: (s) => { s.nextSessionOverride = 'LP'; },
    nextSessionSequence: (s) => { s.nextSessionSequence = 40; },
    anchorProgress: (s) => { s.anchorProgress = { x: 1 }; },
    legacy: (s) => { s.legacy.promotions = { a: 1 }; },
    activeSession: (s) => { s.activeSession = { type: 'RP' }; },
    recovery: (s) => { s.recovery.on = false; },
    armCheck: (s) => { s.armCheck = { date: '2026-10-19', value: 'same' }; },
    ptLevels: (s) => { s.ptLevels = { 'pt-1': 1 }; },
    schemaVersion: (s) => { s.schemaVersion = 9; },
    progressionEngineVersion: (s) => { s.progressionEngineVersion = 4; }
  };
  for (const [name, change] of Object.entries(changes)) {
    const s = JSON.parse(JSON.stringify(base)); change(s);
    assert.notEqual(await fp(s), a, name + ' changes the fingerprint');
  }
  // canonical form: sorted keys, compact, undefined dropped like JSON
  assert.equal(page.ctx.__canonical({ b: 1, a: [2, { d: null, c: 'x' }], e: undefined }), '{"a":[2,{"c":"x","d":null}],"b":1}');
  same(page.ctx.__syncedIdsOf(seedState({ log: [entry(2), entry(1, { notionSync: { status: 'pending' } }), entry(3)] })), ['sid-0002', 'sid-0003']);
});

test('verified: after an Import the committed state matches the file (fingerprint and synced flags), still after a relaunch; a covered change or a lost synced flag un-verifies', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  const incoming = seedState({ log: [entry(4), entry(5, { notionSync: { status: 'pending' } }), entry(6)], rotationIndex: 2 });
  page.ctx.importData({ target: { files: [{ text: JSON.stringify(incoming) }] } });
  await sleep(5); await page.pressModal('Import');
  assert.ok(await until(() => w.reloads === 1));
  const rec = w.store.control.verified;
  assert.ok(rec && /^[0-9a-f]{64}$/.test(rec.fingerprint), 'the record is in the sidecar');
  same(rec.syncedIds, ['sid-0004', 'sid-0006']);
  assert.equal(rec.sessions, 3);
  assert.match(rec.digest, /^[0-9a-f]{8}$/);
  assert.equal(rec.rev, 4, 'the record carries the committed rev');
  // the reload: verified at the record's rev, and the verdict is persisted into the record
  const again = await w.boot();
  await sleep(30);
  assert.equal(again.bridge.verified && again.bridge.verified.ok, true, JSON.stringify(again.bridge.verified));
  assert.equal(again.bridge.verified.changedSince, false);
  assert.equal(w.store.control.verified.ok, true, 'the verdict is in the sidecar');
  assert.ok(w.store.control.verified.checkedAt);
  again.settings(); await sleep(20);
  assert.match(again.els['store-verified'].textContent, /^Import of .+ verified · 3 sessions · digest [0-9a-f]{8}$/);
  // a kill and reopen: still verified (the record is in the sidecar, recomputed on boot)
  w.kill();
  const third = await w.boot();
  await sleep(30);
  assert.equal(third.bridge.verified.ok, true, 'still verified after the relaunch');
  assert.equal(third.bridge.verified.changedSince, false);
  // he trains: the state moves past the record's rev; the verdict stands as history, never a live alarm
  const s2 = third.state(); s2.rotationIndex = 4; third.ctx.saveState(s2); await third.settle();
  await third.ctx.__checkVerified();
  assert.equal(third.bridge.verified.ok, true);
  assert.equal(third.bridge.verified.changedSince, true);
  third.settings(); await sleep(20);
  assert.match(third.els['store-verified'].textContent, /^Import of .+ verified; state has changed since \(3 sessions now\)$/);
  // a covered field differs AT the record's rev (the state is not the imported one): not verified
  const w2 = seededWorld();
  const p2 = await w2.boot(); await p2.settle();
  p2.ctx.importData({ target: { files: [{ text: JSON.stringify(incoming) }] } });
  await sleep(5); await p2.pressModal('Import');
  assert.ok(await until(() => w2.reloads === 1));
  // the committed state at the record's rev is not the imported one (both copies, same _rev, different content)
  const tampered = JSON.parse(w2.raw()); tampered.nextSessionSequence = 99; w2.storage.set('train_state', JSON.stringify(tampered)); w2.store.writeExternally(JSON.stringify(tampered));
  const p3 = await w2.boot(); await sleep(30);
  assert.equal(p3.bridge.verified.ok, false, JSON.stringify(p3.bridge.verified));
  assert.equal(p3.bridge.verified.fingerprintMatch, false);
  assert.equal(w2.store.control.verified.ok, false, 'the verdict persisted');
  p3.settings(); await sleep(20);
  assert.match(p3.els['store-verified'].textContent, /^Import of .+ not verified \(state differs\)$/);
  // synced flag lost on an entry that was synced in the import, same rev: not verified either
  const w3 = seededWorld();
  const p4 = await w3.boot(); await p4.settle();
  p4.ctx.importData({ target: { files: [{ text: JSON.stringify(incoming) }] } });
  await sleep(5); await p4.pressModal('Import');
  assert.ok(await until(() => w3.reloads === 1));
  const lost = JSON.parse(w3.raw()); lost.log[0].notionSync = { status: 'pending' }; w3.storage.set('train_state', JSON.stringify(lost)); w3.store.writeExternally(JSON.stringify(lost));
  const p5 = await w3.boot(); await sleep(30);
  assert.equal(p5.bridge.verified.ok, false);
  assert.equal(p5.bridge.verified.fingerprintMatch, true);
  assert.equal(p5.bridge.verified.syncedOk, false);
  same(p5.bridge.verified.unsynced, ['sid-0004']);
  p5.settings(); await sleep(20);
  assert.match(p5.els['store-verified'].textContent, /not verified \(synced flags changed\)$/);
  // Erase clears the record: the next boot shows nothing about an import
  p5.ctx.confirmErase(); await p5.pressModal('Erase everything');
  assert.ok(await until(() => w3.reloads === 2));
  assert.equal(w3.store.control.verified, null);
  const p6 = await w3.boot(); await sleep(30);
  assert.equal(p6.bridge.verified, null);
  p6.settings(); await sleep(20);
  assert.equal(p6.els['store-verified'].textContent, '');
});

test('the fixture import records verification too, so the simulator smoke exercises the same path', async () => {
  const w = new World();
  w.store.launch = { fixture: 'smoke', smoke: true, reset: false, uiTest: true, probeTombstone: false, probeClient: 'pwa' };
  const page = await w.boot();
  await sleep(30);
  assert.ok(w.store.control.verified && w.store.control.verified.rev === 1);
  assert.equal(page.bridge.verified.ok, true);
  assert.equal(w.store.testNotes.verified.ok, true, 'in the test summary');
});

// ---- 3. the forced-failure drill -----------------------------------------------------------------

test('drill, write-through case: the finalize save fails (write), the page stops saving with the banner; after the relaunch the newest completed session and payload are in active History', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  w.store.hooks.save = async (a) => { delete w.store.hooks.save; return { accepted: false, reason: 'write', rev: w.store.rev, generation: w.store.generation }; };
  const last = await completeSession(page);
  await page.settle();
  assert.match(page.banner(), /refused the last save \(write\)/);
  assert.equal(page.bridge.refused, true);
  assert.equal(w.storage.get('train_store_refused'), undefined, 'a failed write is not a lineage refusal');
  assert.equal(JSON.parse(w.store.file).log.length, 3, 'the file is behind');
  assert.equal(JSON.parse(w.raw()).log.length, 4, 'the local copy has the session');
  const again = await w.boot();
  assert.equal(again.banner(), null, 'no banner: the local copy was written through');
  same(again.bridge.events.filter((e) => e.rule).pop(), { rule: 'writeThrough', fileRev: 3, localRev: JSON.parse(w.raw())._rev });
  const file = JSON.parse(w.store.file);
  const inFile = file.log.find((e) => e.sessionId === last.sessionId);
  assert.ok(inFile, 'the newest completed session is in the authoritative file');
  same(inFile, last, 'with its payload');
  const history = again.state().log;
  assert.equal(history[history.length - 1].sessionId, last.sessionId, 'and in active History');
  assert.equal(history[history.length - 1].sessionStatus, 'completed');
});

test('drill, conflict case: the file moved under the page, so the finalize is refused as stale; after the relaunch both copies are kept, Settings offers Export the saved snapshot beside Export, and the snapshot export imports into the PWA with that session present; rollback is never called successful on the older history', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  const other = JSON.parse(w.store.file); other.log.push(entry(9)); other._base = 3; other._rev = 4;
  w.store.writeExternally(JSON.stringify(other));
  const last = await completeSession(page);
  await page.settle();
  assert.match(page.banner(), /fell behind/);
  const again = await w.boot();
  assert.match(again.banner(), /kept as a snapshot/);
  assert.equal(again.state().log.some((e) => e.sessionId === last.sessionId), false, 'the older history is what loaded: not a successful rollback');
  assert.ok(again.state().log.some((e) => e.sessionId === 'sid-0009'), 'the file’s newer row is there');
  const html = again.settings();
  assert.match(html, /Export the saved snapshot/);
  assert.match(html, /onclick="exportData\(\)"/, 'beside Export');
  // the snapshot export carries the session, and it imports into the PWA (the root harness shape)
  await again.els['store-snapshot-export'].onclick();
  assert.match(w2files(w)[0].path, /^train-snapshot-/);
  const exported = JSON.parse(w2files(w)[0].data);
  assert.ok(exported.log.some((e) => e.sessionId === last.sessionId), 'the snapshot export has the session');
  const pwa = bootPwa();
  pwa.ctx.importData({ target: { files: [{ text: JSON.stringify(exported) }] } });
  await sleep(10);
  const imported = pwa.ctx.getState();
  const row = imported.log.find((e) => e.sessionId === last.sessionId);
  assert.ok(row, 'the PWA has the session after importing the snapshot');
  same(row, last, 'with its payload');
});
function w2files(w) { return w.fsWrites; }

// ---- 4. the tombstone probe (shape; the live call runs only in the simulator) -------------------------

test('tombstone probe: on the CI launch argument, exactly one delete for the fixture’s unused id goes over the original fetch with X-Train-Client: pwa and no key; never on a normal launch', async () => {
  const w = new World();
  w.store.launch = { fixture: 'probe', smoke: true, reset: false, uiTest: true, probeTombstone: true };
  w.syncResponder = (req) => ({ status: 200, body: { ok: true, action: 'noop-absent', sessionId: req.body.sessionId } });
  const page = await w.boot();
  assert.ok(await until(() => w.store.testNotes.probe && w.store.testNotes.probe.status), 'the probe answered');
  const probe = w.store.testNotes.probe;
  assert.equal(probe.status, 200); assert.equal(probe.action, 'noop-absent'); assert.equal(probe.client, 'pwa');
  assert.equal(w.syncRequests.length, 1, 'exactly one live call');
  const q = w.syncRequests[0];
  assert.equal(q.url, SYNC_URL);
  same(q.body, { op: 'delete', sessionId: 'train-probe-unused-00000000' });
  assert.equal(q.headers['X-Train-Client'], 'pwa');
  assert.equal('X-Train-Sync-Key' in q.headers, false, 'no key');
  assert.ok(q.body.sessionId.length >= 8);
  assert.equal(page.state().log.length, 0, 'the fixture has an empty log');
  same(page.state().pendingDeletes, ['train-probe-unused-00000000'], 'the tombstone stays queued: sync is off');
  assert.equal(page.ctx.__sync.armed, false);
  // a launch without the argument never probes
  const w2 = new World();
  w2.store.launch = { fixture: 'probe', smoke: true, reset: false, uiTest: true, probeTombstone: false };
  w2.syncResponder = ok;
  await w2.boot(); await sleep(30);
  assert.equal(w2.syncRequests.length, 0);
});

// ---- review fixes: the switch under transactions, mid-drain off, refusals and History deletes ------

test('a failed Import leaves the switch off everywhere: the page re-reads the sidecar and a later finalize posts nothing', async () => {
  const w = seededWorld();
  w.store.syncArmed = true;
  w.store.failAfterDisarm = true;                   // the state write fails after the first control write (which disarmed)
  w.syncResponder = ok;
  const page = await w.boot();
  await page.settle();
  assert.equal(page.ctx.__sync.armed, true);
  await importViaUi(page, seedState({ log: [entry(8)] }));
  assert.ok(await until(() => page.modalTitle() === 'Import did not happen'));
  assert.equal(w.store.syncArmed, false, 'the sidecar says off');
  assert.ok(await until(() => page.ctx.__sync.armed === false), 'the page re-read it');
  await page.settle();
  w.syncRequests = [];
  w.store.failAfterDisarm = false;
  await completeSession(page);
  await page.settle(); await sleep(40);
  assert.equal(w.syncRequests.length, 0, 'zero requests after the failed import');
  page.settings();
  assert.equal(page.els['store-sync-switch'].textContent, 'Off');
  // the same for a failed Erase
  await page.ctx.__setSyncArmed(true);
  w.store.failAfterDisarm = true;
  page.ctx.confirmErase(); await page.pressModal('Erase everything');
  assert.ok(await until(() => page.modalTitle() === 'Erase did not happen'));
  assert.ok(await until(() => page.ctx.__sync.armed === false));
  w.store.failAfterDisarm = false; w.syncRequests = [];
  await page.ctx.syncEntry(page.state().log[0].sessionId);
  assert.equal(w.syncRequests.length, 0);
});
async function importViaUi(page, data) {
  page.ctx.importData({ target: { files: [{ text: JSON.stringify(data) }] } });
  await sleep(5);
  return page.pressModal('Import');
}

test('the live switch is asked before every request: a store disarmed behind the page stops the drain at once, the rest stay pending', async () => {
  const w = seededWorld(pendingState());
  w.store.syncArmed = true;
  let calls = 0;
  w.syncResponder = () => { calls++; if (calls === 1) w.store.syncArmed = false; return ok(); };   // disarmed after the first answer
  const page = await w.boot();
  assert.ok(await until(() => w.syncRequests.length === 1 && page.ctx.__sync.armed === false), 'one request, then off: ' + w.syncRequests.length);
  await sleep(40);
  assert.equal(w.syncRequests.length, 1, 'nothing after the live check said off');
  const s = page.state();
  assert.equal(s.pendingDeletes.length, 0, 'the first item (the tombstone) went through');
  assert.equal(s.log[0].notionSync.status, 'pending', 'the next entry was never attempted');
  assert.ok(page.bridge.events.some((e) => e.syncDisarmedLive));
  assert.ok(page.bridge.events.some((e) => e.stopped === 'off'));
  assert.equal(w.store.count('status') >= 1, true, 'one status read per request');
});

test('switching off mid-drain leaves the remaining entries pending, not failed with an "off" error', async () => {
  const w = seededWorld(pendingState());
  w.store.syncArmed = true;
  const page = await w.boot();
  let answered = 0;
  w.syncResponder = async () => { answered++; await sleep(30); return ok(); };
  const drain = page.ctx.__syncNow();
  await sleep(10);
  await page.ctx.__setSyncArmed(false);                // off while the tombstone is in flight
  const r = await drain;
  assert.equal(r.stopped, 'off');
  assert.equal(w.syncRequests.length, 1);
  const s = page.state();
  assert.equal(s.log[0].notionSync.status, 'pending');
  assert.equal(s.log[1].notionSync.status, 'failed', 'as seeded, untouched');
  assert.doesNotMatch(String(s.log[0].notionSync.error || ''), /off/);
  // a finalize's syncEntry while off is skipped, not failed
  const last = await completeSession(page);
  await page.settle(); await sleep(20);
  assert.equal(w.syncRequests.length, 1);
  assert.notEqual(page.state().log.find((e) => e.sessionId === last.sessionId).notionSync && page.state().log.find((e) => e.sessionId === last.sessionId).notionSync.status, 'failed');
});

test('after a 403 a History delete does not re-post (the app’s own pushUnsynced is skipped); Sync now and the Retry button (routed to it) start a fresh drain', async () => {
  const w = seededWorld(pendingState());
  w.store.syncArmed = true;
  let calls = 0;
  w.syncResponder = () => { calls++; return calls === 1 ? { status: 403, body: { ok: false, error: 'not the writer' } } : ok(); };
  const page = await w.boot();
  assert.ok(await until(() => page.banner() !== null));
  await sleep(30);
  assert.equal(w.syncRequests.length, 1);
  page.ctx.deleteLogEntry(2);                          // the app ends this with pushUnsynced()
  await page.settle(); await sleep(40);
  assert.equal(w.syncRequests.length, 1, 'no automatic re-post after the refusal');
  assert.ok(page.state().pendingDeletes.includes('sid-0003'), 'the tombstone waits');
  assert.ok(page.bridge.events.filter((e) => e.syncSkipped === 'refused').length >= 1);
  // Retry sync in Settings is Sync now in the shell
  const html = page.settings();
  assert.doesNotMatch(html, /onclick="pushUnsynced\(\)"/);
  assert.match(html, /onclick="__syncNow\(\)"/);
  const r = await page.ctx.__syncNow();
  assert.equal(r.stopped, null);
  assert.ok(w.syncRequests.length > 1, 'Sync now posted');
  assert.equal(page.state().pendingDeletes.length, 0);
});

test('re-arming during a transaction’s quiesce window is refused with a message; the switch stays off', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  page.ctx.__sync.inflight = 1;
  await importViaUi(page, seedState({ log: [entry(8)] }));
  await sleep(5);
  assert.equal(page.ctx.__sync.quiescing, true);
  const armed = await page.ctx.__setSyncArmed(true);
  assert.equal(armed, false);
  assert.equal(page.modalTitle(), 'A change is in progress');
  assert.equal(w.store.count('setSyncArmed'), 0, 'no write');
  assert.ok(await until(() => page.modalTitle() === 'Still syncing'));
  page.ctx.__sync.inflight = 0;
  assert.equal(page.ctx.__sync.armed, false);
});

test('the probe refuses a tombstone that is not the fixture’s, and sends the client named by the launch argument', async () => {
  const w = seededWorld(seedState({ log: [], pendingDeletes: ['sid-0042-real-row'] }));
  w.store.launch = { fixture: null, smoke: true, reset: false, uiTest: true, probeTombstone: true, probeClient: 'pwa' };
  w.syncResponder = ok;
  const page = await w.boot();
  assert.ok(await until(() => w.store.testNotes.probe));
  assert.equal(w.store.testNotes.probe.error, 'not the probe fixture');
  assert.equal(w.syncRequests.length, 0, 'nothing posted for a real id');
  const w2 = new World();
  w2.store.launch = { fixture: 'probe', smoke: true, reset: false, uiTest: true, probeTombstone: true, probeClient: 'native' };
  w2.syncResponder = (req) => ({ status: 200, body: { ok: true, action: 'noop-absent', sessionId: req.body.sessionId } });
  await w2.boot();
  assert.ok(await until(() => w2.store.testNotes.probe && w2.store.testNotes.probe.status));
  assert.equal(w2.syncRequests[0].headers['X-Train-Client'], 'native');
  assert.equal(w2.store.testNotes.probe.client, 'native');
  assert.equal(page.ctx.__sync.armed, false);
});

test('the store card’s buttons survive a re-parse of the container: inline handlers to globals, and the harness drops property handlers on innerHTML writes', async () => {
  const w = seededWorld();
  const page = await w.boot();
  const html = page.settings();
  assert.match(html, /id="store-sync-switch"[^>]*aria-label="Start syncing from this app"[^>]*onclick="__toggleSyncArmed\(\)"/);
  assert.match(html, /id="store-sync-now"[^>]*onclick="__syncNow\(\)"/);
  assert.equal(typeof page.ctx.__toggleSyncArmed, 'function');
  assert.equal(typeof page.ctx.__syncNow, 'function');
  assert.equal(typeof page.ctx.__exportSnapshot, 'function');
  assert.equal(typeof page.ctx.__startEmbedTest, 'function');
  // the harness models the DOM: assigning innerHTML on a parent detaches its children's handlers
  const parent = page.ctx.document.createElement('div'); const child = page.ctx.document.createElement('button'); child.onclick = () => 1; parent.appendChild(child);
  parent.innerHTML = '<button>x</button>';
  assert.equal(child.onclick, null);
  // the inline handler path: __toggleSyncArmed opens the confirm
  page.ctx.__toggleSyncArmed();
  assert.equal(page.modalTitle(), 'Start syncing from this app?');
  await page.pressModal('Cancel');
  assert.equal(page.ctx.__sync.armed, false);
  assert.equal(w.store.syncArmed, false);
});
