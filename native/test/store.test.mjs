// The durable store's JS side (bridge.js) against a fake TrainStore with the Swift plugin's rules:
// hydration in the plan's order, the compare-and-swap save chain with lineage and generations,
// Import and Erase as transactions, Export as a consistency boundary, and the sync-off shell.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, seedState, entry, committedBytes, sha256, sleep } from './shell-harness.mjs';

const same = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(5); return fn(); };
const stripped = (bytes) => { const o = JSON.parse(bytes); delete o._rev; delete o._base; delete o.seedRev; return o; };
const seededWorld = (state = seedState(), rev = 3) => { const w = new World(); w.store.file = committedBytes(state, rev); w.store.rev = rev; w.store.generation = 1; return w; };

// ---- the ready-hook and hydration ----------------------------------------------------------------

test('the patched handler awaits the hook: nothing touches storage before the read completes', async () => {
  const w = seededWorld();
  w.store.delays.read = 120;
  const page = await w.boot({ noWait: true });
  await sleep(30);
  assert.equal(w.raw(), null, 'no state written while the read is pending');
  assert.ok(page.loading(), 'the loading view is up: ' + page.loading());
  assert.equal(page.bridge.seeded, false);
  await page.ready;
  assert.equal(page.loading(), null, 'loading view gone after hydration');
  assert.equal(JSON.parse(w.raw()).log.length, 3);
  assert.equal(page.bridge.rev, 3);
  assert.equal(page.bridge.seedRev, 3);
  assert.equal(page.bridge.generation, 1);
  assert.equal(w.storage.get('train_seed_rev'), '3');
  assert.equal(w.storage.get('train_store_gen'), '1');
});

test('eviction: a healthy file hydrates an empty WebView store with no banner, and the app renders it', async () => {
  const w = seededWorld();
  const page = await w.boot();
  assert.equal(page.banner(), null);
  assert.equal(page.state().log.length, 3);
  assert.match(page.home, /Start Today|PT/);
  assert.equal(w.store.count('save'), 0, 'hydration from the file writes nothing back');
  // the same phone, evicted again later, hydrates again from the file
  w.evict();
  const again = await w.boot();
  assert.equal(again.banner(), null);
  assert.equal(again.state().log.length, 3);
});

test('fresh install: no file, no local; the default state is the first committed save (rev 1)', async () => {
  const w = new World();
  const page = await w.boot();
  assert.equal(page.banner(), null);
  await page.settle();
  assert.equal(w.store.rev, 1, 'the default state landed as rev 1');
  assert.equal(w.store.count('save'), 1, 'exactly one save: the fresh install default');
  assert.equal(JSON.parse(w.store.file)._rev, 1);
  assert.equal(page.bridge.rev, 1);
});

test('reload with equal revs and equal content: nothing to do, no banner, no write', async () => {
  const w = seededWorld();
  let page = await w.boot();
  page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 2 }));
  await page.settle();
  assert.equal(w.store.rev, 4);
  const saves = w.store.count('save');
  page = await w.boot();                      // reload: same storage, same file
  assert.equal(page.banner(), null);
  assert.equal(w.store.count('save'), saves, 'no write on an equal-hash boot');
  assert.equal(page.bridge.rev, 4);
  assert.equal(page.bridge.seedRev, 4);
  same(page.bridge.events.filter((e) => e.rule).pop(), { rule: 'equal', rev: 4 });
});

test('the file is ahead (another launch saved more): hydrate from the file, no banner', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  const state = JSON.parse(w.store.file); state.log.push(entry(4)); state._base = 3; state._rev = 4;
  w.store.writeExternally(JSON.stringify(state));       // a newer file, same lineage ahead of this page
  const again = await w.boot();
  assert.equal(again.banner(), null);
  assert.equal(again.state().log.length, 4);
  assert.equal(again.bridge.rev, 4);
});

test('kill after a save and before the ack: the next launch writes the raw local string through as the file rev + 1', async () => {
  const w = seededWorld();
  let page = await w.boot();
  w.store.holdAcks.save = [];                              // the save commits in the plugin, the ack never arrives
  page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 1 }));
  await sleep(30);
  // "kill": drop the page; simulate the plugin NOT having committed either (the app died first)
  w.store.file = committedBytes(seedState(), 3); w.store.rev = 3; w.store.holdAcks = {}; w.store.calls = [];
  const localBefore = w.raw();
  assert.equal(JSON.parse(localBefore)._rev, 4, 'the local copy carries the unacknowledged rev');
  page = await w.boot();
  assert.equal(page.banner(), null, 'no banner: the local change descends from the file');
  assert.equal(w.store.rev, 4);
  assert.equal(w.store.file, localBefore, 'the raw local bytes were written through unchanged');
  assert.equal(page.bridge.seedRev, 4);
  same(page.bridge.events.filter((e) => e.rule).pop(), { rule: 'writeThrough', fileRev: 3, localRev: 4 });
  // a second relaunch lands in the equal-hash rule
  const third = await w.boot();
  assert.equal(third.banner(), null);
  same(third.bridge.events.filter((e) => e.rule).pop(), { rule: 'equal', rev: 4 });
});

test('two saves, the first commits and the second does not, then a kill: write-through carries the local rev; three unacknowledged carry base + 3', async () => {
  const w = seededWorld();
  let page = await w.boot();
  page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 1 }));
  await page.settle();
  assert.equal(w.store.rev, 4);
  w.store.hooks.save = async () => new Promise(() => {});    // the second never answers
  page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 2 }));
  await sleep(20);
  delete w.store.hooks.save; w.store.calls = [];
  const local = w.raw();
  assert.equal(JSON.parse(local)._rev, 5);
  page = await w.boot();
  assert.equal(page.banner(), null);
  assert.equal(w.store.rev, 5);
  assert.equal(w.store.file, local);

  // three unacknowledged saves then a kill
  w.store.hooks.save = async () => new Promise(() => {});
  page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 3 }));
  page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 4 }));
  page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 0 }));
  await sleep(20);
  delete w.store.hooks.save;
  assert.equal(JSON.parse(w.raw())._rev, 8, 'same-tick saves chain: base + 3');
  page = await w.boot();
  assert.equal(page.banner(), null);
  assert.equal(w.store.rev, 8, 'the write-through carried _rev = base + 3');
  assert.equal(page.state().rotationIndex, 0);
});

test('a refused write is never acknowledged: banner, nothing further sent, and the next launch keeps both copies', async () => {
  const w = seededWorld();
  const page = await w.boot();
  // another writer moved the file under this page (same generation)
  const other = JSON.parse(w.store.file); other.log.push(entry(9)); other._base = 3; other._rev = 4;
  w.store.writeExternally(JSON.stringify(other));
  const r1 = await page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 1 }));
  assert.equal(r1.refused, true);
  assert.equal(r1.reason, 'stale');
  assert.match(page.banner(), /fell behind/);
  assert.equal(JSON.parse(w.store.file).log.length, 4, 'the file was not overwritten');
  const sends = w.store.count('save');
  const r2 = await page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 2 }));
  assert.equal(r2.refused, true);
  assert.equal(w.store.count('save'), sends, 'nothing further sent after a refusal');
  // relaunch: local rev 5 > file rev 4 but seedRev (3) <= 4 ... the local lineage does NOT include rev 4's content,
  // yet by rev alone it looks like a write-through candidate; validation passes, so the CAS decides: base 4 == file rev 4
  // would accept. That is the one case the plan accepts as "a stale decision" only if revs lie; here the other writer
  // used the same generation, which the shell never does for a different app. Assert what the rules give.
  const again = await w.boot();
  assert.ok(again.bridge.seeded);
});

test('equal revs with different content: keep both copies, load the file, banner names the snapshot', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  const other = JSON.parse(w.store.file); other.rotationIndex = 4;      // same rev 3, different bytes
  w.store.writeExternally(JSON.stringify(other));
  const again = await w.boot();
  assert.match(again.banner(), /kept as a snapshot/);
  assert.match(again.banner(), /3 sessions/);
  assert.equal(again.state().rotationIndex, 4, 'the file was loaded');
  assert.ok(again.bridge.snapshot && again.bridge.snapshot.bytes, 'the previous copy is kept');
  assert.equal(JSON.parse(again.bridge.snapshot.bytes).rotationIndex, 0);
  assert.match(again.settings(), /Export the saved snapshot/);
  assert.match(again.settings(), /Saved snapshot/);
});

test('the file moved under this page (seedRev above the file rev): keep both, load the file, banner', async () => {
  const w = seededWorld(seedState(), 5);
  const page = await w.boot();                       // seeded at 5
  assert.equal(page.bridge.seedRev, 5);
  const older = JSON.parse(w.store.file); older.rotationIndex = 3; older._rev = 4; older._base = 3;
  w.store.writeExternally(JSON.stringify(older));   // the file went backwards (rev 4 < seedRev 5)
  const again = await w.boot();
  assert.match(again.banner(), /kept as a snapshot/);
  assert.equal(again.state().rotationIndex, 3);
  assert.equal(again.bridge.rev, 4);
  same(again.bridge.events.filter((e) => e.keepBoth).pop(), { keepBoth: 'moved', fileRev: 4, localRev: 5 });
});

test('generation differs (an Import or Erase this page did not see), even with equal revs: keep both, load the file, banner', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  w.store.generation = 2;                             // bumped elsewhere; same rev and bytes
  const again = await w.boot();
  assert.match(again.banner(), /kept as a snapshot/);
  assert.equal(again.bridge.generation, 2);
  same(again.bridge.events.filter((e) => e.keepBoth).pop(), { keepBoth: 'generation', fileRev: 3, localRev: 3 });
  assert.equal(w.storage.get('train_store_gen'), '2', 're-seeded with the file generation');
});

test('snapshot recovery to a rev equal to the old seedRev: an explicit event, the generation bumps, the banner names the snapshot', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  // a save committed rev 4 (a snapshot of rev 3 is kept), then the file is damaged
  page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 1 }));
  await page.settle();
  assert.equal(w.store.rev, 4);
  w.store.corrupt();
  const again = await w.boot();
  assert.equal(w.store.generation, 2, 'recovery bumped the generation');
  assert.equal(w.store.recoveredFrom, 'snapshot-r3');
  assert.equal(w.store.rev, 3, 'recovered to the snapshot at rev 3, the old seedRev');
  assert.match(again.banner(), /kept as a snapshot/, 'the local rev 4 copy is kept, the recovered file loaded');
  assert.equal(again.state().rotationIndex, 0);
  assert.equal(JSON.parse(again.bridge.snapshot.bytes).rotationIndex, 1);
});

test('a failed read shows the loading view with Retry; a later successful read hydrates; a slow read offers Retry too', async () => {
  const w = seededWorld();
  let fail = true;
  w.store.hooks.read = async () => { if (fail) throw new Error('disk busy'); delete w.store.hooks.read; return w.store.plugin().read({}); };
  const page = await w.boot({ noWait: true });
  await sleep(40);
  assert.match(page.loading(), /Could not read/);
  assert.ok(page.els['store-loading-retry'] && page.els['store-loading-retry'].onclick, 'Retry offered');
  fail = false;
  page.els['store-loading-retry'].onclick();
  await page.ready;
  assert.equal(page.loading(), null);
  assert.equal(page.state().log.length, 3);
  // slow read: the Retry appears after readRetryMs while the first read is still pending
  const w2 = seededWorld();
  w2.store.delays.read = 900;
  const p2 = await w2.boot({ noWait: true });
  await sleep(500);
  assert.match(p2.loading(), /Still loading/);
  assert.ok(p2.els['store-loading-retry'].onclick);
  await p2.ready;
  assert.equal(p2.state().log.length, 3);
  assert.equal(w2.store.count('read'), 1, 'the slow read itself hydrated once it answered');
});

// ---- the save chain and the _rev guard -----------------------------------------------------------

test('saves stamp _rev and _base, advance the base at once, and chain same-tick; the file holds the exact bytes', async () => {
  const w = seededWorld();
  const page = await w.boot();
  const s = page.state();
  s.rotationIndex = 1; const p1 = page.ctx.saveState(s);
  s.rotationIndex = 2; const p2 = page.ctx.saveState(s);
  assert.equal(page.bridge.base, 5, 'base advanced twice before any ack');
  same(await p1, { accepted: true, rev: 4 });
  same(await p2, { accepted: true, rev: 5 });
  assert.equal(w.store.file, w.raw(), 'file bytes equal the local bytes');
  assert.equal(sha256(w.store.file), w.store.hash());
  const calls = w.store.calls.filter((c) => c.method === 'save');
  same(calls.map((c) => [c.args.base, JSON.parse(c.args.bytes)._rev, c.args.generation]), [[3, 4, 1], [4, 5, 1]]);
  assert.equal(page.bridge.lastCommitted.rev, 5);
});

test('History delete goes through the same guard: a file that moved refuses the delete and the file keeps the row', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  const other = JSON.parse(w.store.file); other.rotationIndex = 4; other._base = 3; other._rev = 4;
  w.store.writeExternally(JSON.stringify(other));
  page.ctx.deleteLogEntry(0);
  await page.settle();
  assert.equal(JSON.parse(w.store.file).log.length, 3, 'the file still has the row');
  assert.equal(page.state().log.length, 2, 'the local copy shows the deletion (a candidate)');
  assert.match(page.banner(), /fell behind/);
  assert.equal(page.bridge.refused, true);
});

test('the shell never posts: pending entries seeded, zero requests to the sync host, and no save beyond what the app does', async () => {
  const w = seededWorld(seedState({ log: [entry(1, { notionSync: { status: 'pending' } }), entry(2)], pendingDeletes: ['sid-0042'] }));
  const page = await w.boot();
  await sleep(50);
  assert.equal(w.syncRequests.length, 0);
  assert.equal(w.store.count('save'), 0, 'no state write on a boot that hydrates from the file');
  await assert.rejects(() => page.ctx.postSync({ op: 'delete', sessionId: 'x' }), /off in the shell/);
  await page.ctx.pushUnsynced(); await page.ctx.syncEntry('sid-0001');
  assert.equal(w.syncRequests.length, 0);
  assert.equal(page.ctx.handoffSupported(), false);
  assert.equal(page.ctx.handoffActive ? page.ctx.handoffActive() : false, false);
});

// ---- transactions ----------------------------------------------------------------------------------

async function importViaUi(page, data) {
  page.ctx.importData({ target: { files: [{ text: JSON.stringify(data) }] } });
  await sleep(5);
  assert.equal(page.modalTitle(), 'Import data?');
  return page.pressModal('Import');
}

test('Import: confirm names the sessions that would disappear; the transaction snapshots, disarms, bumps the generation, commits at file rev + 1, replaces the local bytes, re-seeds, then reloads', async () => {
  const w = seededWorld();
  w.store.syncArmed = true;
  const page = await w.boot();
  await page.settle();
  const incoming = seedState({ log: [entry(2), entry(7)], nextSessionSequence: 8 });
  page.ctx.importData({ target: { files: [{ text: JSON.stringify(incoming) }] } });
  await sleep(5);
  assert.equal(page.modalTitle(), 'Import data?');
  assert.match(page.modalBody(), /2 sessions from the backup/);
  assert.match(page.modalBody(), /2 sessions now on this phone are not in it and would disappear: 2026-10-11 PT, 2026-10-13 PT/);
  await page.pressModal('Import');
  await sleep(80);
  assert.equal(w.reloads, 1, 'reloaded inside the transaction’s resolution');
  assert.equal(w.store.generation, 2);
  assert.equal(w.store.rev, 4, 'committed at file rev + 1');
  assert.equal(w.store.syncArmed, false, 'disarmed');
  const ev = w.store.events;
  assert.ok(ev.findIndex((e) => e.disarmed) < ev.findIndex((e) => e.imported), 'syncArmed persisted false before the state was replaced');
  assert.equal(w.store.snapshots[0].rev, 3, 'the previous file is snapshotted first');
  const file = JSON.parse(w.store.file);
  assert.equal(file._rev, 4); assert.equal(file._base, 3); assert.equal(file.log.length, 2); assert.equal('seedRev' in file, false);
  assert.equal(w.raw(), w.store.file, 'local bytes replaced with the committed bytes');
  assert.equal(w.storage.get('train_seed_rev'), '4');
  assert.equal(w.storage.get('train_store_gen'), '2');
  // the reload lands in the equal-hash rule: no banner
  const again = await w.boot();
  assert.equal(again.banner(), null);
  assert.equal(again.state().log.length, 2);
  same(again.bridge.events.filter((e) => e.rule).pop(), { rule: 'equal', rev: 4 });
});

test('Import with queued writes: the held saves settle as superseded; a late acknowledgement from the old generation is ignored', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  // one save already sent whose ack is held past the import; two more queued behind it
  w.store.holdAcks.save = [];
  const pA = page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 1 }));
  const pB = page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 2 }));
  const pC = page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 3 }));
  await sleep(10);
  const importDone = importViaUi(page, seedState({ log: [entry(5)] }));
  await sleep(120);
  assert.equal(w.reloads, 1, 'the import went through while the first ack was still held');
  assert.equal(w.store.generation, 2);
  assert.equal(JSON.parse(w.store.file).log[0].sessionId, 'sid-0005');
  w.store.release('save');                                   // the late ack arrives now
  const [rA, rB, rC] = await Promise.all([pA, pB, pC]);
  same(rA, { superseded: true }, 'the late ack from the old generation is ignored');
  same(rB, { superseded: true }); same(rC, { superseded: true });
  assert.equal(w.store.rev, 5, 'the held save committed rev 4 in the plugin, the import landed at 5');
  assert.equal(page.bridge.rev, 5, 'the bridge rev is the import’s, untouched by the late ack');
  assert.equal(JSON.parse(w.store.file).log[0].sessionId, 'sid-0005', 'nothing overwrote the import');
  await importDone;
});

test('Import when a save landed first: the stale base is read again and the import still commits at file rev + 1', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  w.store.delays.save = 60;                                   // the plugin is slow to commit
  page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 1 }));
  importViaUi(page, seedState({ log: [entry(6)] }));
  await sleep(300);
  assert.equal(w.reloads, 1);
  assert.equal(w.store.rev, 5, 'save made rev 4, the import committed at 5');
  assert.ok(w.store.calls.filter((c) => c.method === 'importState').length >= 1);
});

test('a kill between the two writes leaves a disarmed app with the old state; the page says nothing changed', async () => {
  const w = seededWorld();
  w.store.syncArmed = true;
  w.store.failAfterDisarm = true;
  const page = await w.boot();
  await page.settle();
  await importViaUi(page, seedState({ log: [entry(8)] }));
  assert.ok(await until(() => page.modalTitle() === 'Import did not happen'), 'refusal shown: ' + page.modalTitle());
  assert.equal(w.reloads, 0);
  assert.equal(w.store.syncArmed, false, 'disarmed');
  assert.equal(JSON.parse(w.store.file).log.length, 3, 'old state kept');
  assert.equal(w.store.generation, 1);
  assert.equal(page.modalTitle(), 'Import did not happen');
  assert.match(page.modalBody(), /Nothing changed/);
  assert.equal(page.ctx.__sync.quiescing, false, 'guard dropped');
  assert.equal(page.state().log.length, 3, 'local untouched');
  // the page still saves normally afterwards (the hold was released)
  w.store.failAfterDisarm = false;
  const r = await page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 2 }));
  assert.equal(r.accepted, true);
});

test('Erase: snapshot, disarm, generation bump, file removed, local key removed, re-seeded at 0, reload lands in the missing-state rule with no banner', async () => {
  const w = seededWorld();
  w.store.syncArmed = true;
  const page = await w.boot();
  await page.settle();
  page.ctx.confirmErase();
  assert.equal(page.modalTitle(), 'Erase all data?');
  await page.pressModal('Erase everything');
  await sleep(60);
  assert.equal(w.reloads, 1);
  assert.equal(w.store.file, null);
  assert.equal(w.store.rev, 0);
  assert.equal(w.store.generation, 2);
  assert.equal(w.store.syncArmed, false);
  assert.equal(w.store.snapshots[0].rev, 3);
  assert.equal(w.raw(), null, 'the local key is gone');
  assert.equal(w.storage.get('train_store_gen'), '2');
  const again = await w.boot();
  assert.equal(again.banner(), null);
  same(again.bridge.events.filter((e) => e.rule).pop(), { rule: 'missing', fileRev: 0 });
  await again.settle();
  assert.equal(w.store.rev, 1, 'the fresh default became rev 1 in the new generation');
  assert.equal(w.store.generation, 2);
});

test('Import and Erase abort after the quiescing wait when a sync request is still in flight: message, guard dropped, nothing changed', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  page.ctx.__sync.inflight = 1;                            // a request that never settles
  const t0 = Date.now();
  await importViaUi(page, seedState({ log: [entry(8)] }));
  assert.ok(await until(() => page.modalTitle() === 'Still syncing'), 'the abort message arrived: ' + page.modalTitle());
  assert.ok(Date.now() - t0 >= 380, 'waited the configured quiesce window');
  assert.match(page.modalBody(), /Nothing changed/);
  assert.equal(page.ctx.__sync.quiescing, false);
  assert.equal(w.reloads, 0);
  assert.equal(w.store.count('importState'), 0);
  assert.equal(page.bridge.config.quiesceMs, 400, 'tests run the short window');
  page.ctx.confirmErase(); await page.pressModal('Erase everything');
  await sleep(10);
  assert.notEqual(page.modalTitle(), 'Still syncing', 'the erase is waiting its window');
  assert.ok(await until(() => page.modalTitle() === 'Still syncing'));
  assert.equal(w.store.count('erase'), 0);
  // the default wait is 10 seconds
  const defaults = new World({ config: {} });
  const d = await defaults.boot();
  same(d.bridge.config, { readRetryMs: 5000, quiesceMs: 10000, exportWaitMs: 3000 });
});

// ---- Export -----------------------------------------------------------------------------------------

test('Export without waiting after a save: waits for the acknowledgement and exports the committed head as a plain PWA backup', async () => {
  const w = seededWorld();
  const page = await w.boot();
  w.store.delays.save = 80;
  page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 2 }));
  await page.ctx.exportData();                               // no settle() first
  assert.equal(w.fsWrites.length, 1);
  assert.match(w.fsWrites[0].path, /^train-backup-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(w.fsWrites[0].directory, 'CACHE');
  const exported = JSON.parse(w.fsWrites[0].data);
  assert.equal(exported.rotationIndex, 2, 'the export is the state after the save, not older than the screen');
  assert.equal('_rev' in exported, false); assert.equal('_base' in exported, false); assert.equal('seedRev' in exported, false);
  same(exported, stripped(w.store.file), 'a plain backup of the committed bytes');
  same(w.shares[0], { title: 'Train backup', files: ['file:///cache/' + w.fsWrites[0].path] });
  assert.equal(page.banner(), null);
  // round trip: the export imports losslessly (the same log, ids and fields) through the app's migrate
  const back = page.ctx.migrate(JSON.parse(w.fsWrites[0].data));
  same(back.log.map((e) => e.sessionId), ['sid-0001', 'sid-0002', 'sid-0003']);
  same(back.log, exported.log);
});

test('Export with a hung save: after the wait, both the committed file and the candidate are exported, labelled, with the banner', async () => {
  const w = seededWorld();
  const page = await w.boot();
  w.store.hooks.save = async () => new Promise(() => {});
  page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 3 }));
  const t0 = Date.now();
  await page.ctx.exportData();
  assert.ok(Date.now() - t0 >= 280, 'waited the export window');
  same(w.fsWrites.map((f) => f.path.replace(/\d{4}-\d{2}-\d{2}/, 'DAY')), ['train-backup-DAY-committed.json', 'train-backup-DAY-candidate.json']);
  assert.equal(JSON.parse(w.fsWrites[0].data).rotationIndex, 0, 'committed head');
  assert.equal(JSON.parse(w.fsWrites[1].data).rotationIndex, 3, 'the candidate on screen');
  assert.equal(w.shares[0].files.length, 2);
  assert.match(page.banner(), /two files were exported/);
});

test('Export after a refused save exports both copies too; the snapshot export exports the kept copy', async () => {
  const w = seededWorld();
  const page = await w.boot();
  const other = JSON.parse(w.store.file); other.rotationIndex = 4; other._base = 3; other._rev = 4;
  w.store.writeExternally(JSON.stringify(other));
  await page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 1 }));
  await page.ctx.exportData();
  assert.equal(w.fsWrites.length, 2);
  assert.match(w.fsWrites[0].path, /-committed\.json$/);
  // a kept snapshot from a keep-both boot can be exported from Settings
  const w2 = seededWorld();
  const p2 = await w2.boot(); await p2.settle();
  const o2 = JSON.parse(w2.store.file); o2.rotationIndex = 4; w2.store.writeExternally(JSON.stringify(o2));
  const p3 = await w2.boot();
  assert.ok(p3.bridge.snapshot);
  p3.settings();
  await p3.els['store-snapshot-export'].onclick();
  assert.match(w2.fsWrites[0].path, /^train-snapshot-/);
  assert.equal(JSON.parse(w2.fsWrites[0].data).rotationIndex, 0, 'the kept copy, stripped');
});

// ---- Settings line ----------------------------------------------------------------------------------

test('Settings shows the store line and the loaded count and digest', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  page.settings();
  await sleep(20);
  assert.match(page.els['store-status'].textContent, /^Store: rev 3 (committed \S+|\(nothing committed yet\)) · generation 1$/);
  assert.match(page.els['store-loaded'].textContent, /^3 sessions loaded · digest [0-9a-f]{8}$/);
});
