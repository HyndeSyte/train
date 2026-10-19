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
  assert.equal(page.loadingDisplay(), 'none', 'hidden by display too (the inline style sets display:flex, which beats the hidden attribute)');
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

test('a refused write is never acknowledged: banner, nothing further sent, and the next launch keeps both copies (a stale page never overwrites newer data)', async () => {
  const w = seededWorld();
  const page = await w.boot();
  // another writer moved the file under this page (same generation): rev 4 with sid-0009
  const other = JSON.parse(w.store.file); other.log.push(entry(9)); other._base = 3; other._rev = 4;
  w.store.writeExternally(JSON.stringify(other));
  const r1 = await page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 1 }));
  assert.equal(r1.refused, true);
  assert.equal(r1.reason, 'stale');
  assert.match(page.banner(), /fell behind the app’s saved data\. This copy stops saving until the app relaunches/);
  assert.equal(JSON.parse(w.store.file).log.length, 4, 'the file was not overwritten');
  assert.equal(w.storage.get('train_store_refused'), '1', 'the refusal is persisted for the next launch');
  const sends = w.store.count('save');
  // the page keeps stamping: two more local saves take the local copy to rev 6, still refused, nothing sent
  const r2 = await page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 2 }));
  assert.equal(r2.refused, true);
  await page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 2 }));
  assert.equal(JSON.parse(w.raw())._rev, 6);
  assert.equal(w.store.count('save'), sends, 'nothing further sent after a refusal');
  // relaunch: local rev 6 > file rev 4 and seedRev 3 <= 4 would pass rule 4 by revs alone; the marker keeps both
  const again = await w.boot();
  assert.match(again.banner(), /kept as a snapshot/);
  assert.equal(JSON.parse(w.store.file).log.length, 4, 'the file still holds the other writer’s data');
  assert.ok(JSON.parse(w.store.file).log.some((e) => e.sessionId === 'sid-0009'), 'sid-0009 survived the relaunch');
  assert.equal(again.state().log.length, 4, 'the file was loaded');
  assert.equal(again.state().rotationIndex, 0);
  assert.equal(JSON.parse(again.bridge.snapshot.bytes).rotationIndex, 2, 'the stale page’s copy is the kept snapshot');
  same(again.bridge.events.filter((e) => e.keepBoth).pop(), { keepBoth: 'moved', fileRev: 4, localRev: 6 });
  assert.ok(again.bridge.events.some((e) => e.refusedMarker), 'the marker was the reason');
  assert.equal(w.storage.get('train_store_refused'), undefined, 'the marker is cleared by the new seeding');
  assert.equal(w.store.count('save'), sends, 'no write-through happened');
  // the relaunched page saves normally from the file's rev
  const r3 = await again.ctx.saveState(Object.assign(again.state(), { rotationIndex: 1 }));
  same(r3, { accepted: true, rev: 5 });
});

test('a generation refusal the page did not cause (the store was replaced) is a refusal: banner names it, marker set, relaunch keeps both', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  w.store.generation = 2;                              // replaced by something this page never saw
  const r = await page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 1 }));
  same(r, { refused: true, reason: 'generation' });
  assert.match(page.banner(), /store was replaced/);
  assert.equal(w.storage.get('train_store_refused'), '1');
  const again = await w.boot();
  assert.match(again.banner(), /kept as a snapshot/);
  same(again.bridge.events.filter((e) => e.keepBoth).pop(), { keepBoth: 'generation', fileRev: 3, localRev: 4 });
  assert.equal(again.bridge.generation, 2);
});

test('a present train_state with no seed key never enters write-through: keep both (a missing generation key likewise)', async () => {
  const w = seededWorld();
  const local = JSON.parse(w.store.file); local.rotationIndex = 7; local._rev = 5; local._base = 4;
  w.storage.set('train_state', JSON.stringify(local)); w.storage.set('train_store_gen', '1');   // no train_seed_rev
  const page = await w.boot();
  assert.match(page.banner(), /kept as a snapshot/);
  same(page.bridge.events.filter((e) => e.keepBoth).pop(), { keepBoth: 'moved', fileRev: 3, localRev: 5 });
  assert.equal(page.state().rotationIndex, 0, 'the file was loaded');
  assert.equal(w.store.count('save'), 0);
  const w2 = seededWorld();
  w2.storage.set('train_state', JSON.stringify(local)); w2.storage.set('train_seed_rev', '3');  // no train_store_gen
  const p2 = await w2.boot();
  same(p2.bridge.events.filter((e) => e.keepBoth).pop(), { keepBoth: 'generation', fileRev: 3, localRev: 5 });
  assert.equal(w2.store.count('save'), 0);
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
  w2.store.delays.read = 2500;                              // well past readRetryMs (400 in the tests)
  const p2 = await w2.boot({ noWait: true });
  assert.ok(await until(() => /Still loading/.test(p2.loading() || ''), 2000), 'the slow-read text appeared: ' + p2.loading());
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
  assert.ok(await until(() => w.reloads === 1), 'reloaded inside the transaction’s resolution');
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
  assert.ok(await until(() => w.reloads === 1), 'the import went through while the first ack was still held');
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

test('Import when a save landed first: the stale base is refused, read again, and the import commits at file rev + 1', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  w.store.delays.save = 60;                                   // the plugin is slow to commit the save already sent
  page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 1 }));
  // the first status answers before that save commits (rev 3); the importState queued behind the save then finds rev 4
  w.store.hooks.status = async () => { delete w.store.hooks.status; return { rev: 3, generation: 1, committedAt: null, syncArmed: false, recoveredFrom: null, hasFile: true, snapshots: 0 }; };
  importViaUi(page, seedState({ log: [entry(6)] }));
  assert.ok(await until(() => w.reloads === 1), 'the import went through');
  const attempts = w.store.results('importState');
  assert.equal(attempts.length, 2, 'two attempts');
  same(attempts[0], { accepted: false, reason: 'stale', rev: 4, generation: 1 }, 'the first was refused as stale by the committed save');
  assert.equal(attempts[1].accepted, true);
  assert.equal(w.store.rev, 5, 'save made rev 4, the import committed at 5');
  assert.equal(w.store.generation, 2);
  assert.equal(JSON.parse(w.store.file).log[0].sessionId, 'sid-0006');
});

test('a kill after the first control write (disarm + generation bump): the relaunch reads syncArmed false from the sidecar, the old state is loaded and the local copy kept with a banner', async () => {
  const w = seededWorld();
  w.store.syncArmed = true;
  const page = await w.boot();
  await page.settle();
  page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 2 }));
  await page.settle();                                           // local and file at rev 4
  w.store.killAt = 'afterFirstControl';
  importViaUi(page, seedState({ log: [entry(8)] }));
  await sleep(30);
  assert.equal(w.store.count('importState'), 1);
  w.kill();                                                      // the app dies; the import never answers
  same({ generation: w.store.control.generation, rev: w.store.control.rev, syncArmed: w.store.control.syncArmed }, { generation: 2, rev: 4, syncArmed: false }, 'the sidecar as the kill left it');
  const again = await w.boot();
  assert.equal(w.store.syncArmed, false, 'read back disarmed');
  assert.match(again.banner(), /kept as a snapshot/, 'the generation rule keeps both copies');
  same(again.bridge.events.filter((e) => e.keepBoth).pop(), { keepBoth: 'generation', fileRev: 4, localRev: 4 });
  assert.equal(again.state().log.length, 3, 'the old state, not the import');
  assert.equal(again.bridge.generation, 2);
  assert.equal(w.store.count('save'), 1, 'nothing written through');
});

test('a kill after the state write and before the control rev: the next read heals the rev from the bytes; the aborted import is not committed silently, both copies are kept with a banner', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  w.store.killAt = 'afterState';
  importViaUi(page, seedState({ log: [entry(8)] }));
  await sleep(30);
  w.kill();
  same({ generation: w.store.control.generation, rev: w.store.control.rev }, { generation: 2, rev: 3 }, 'state at rev 4 on disk, control rev still 3');
  assert.equal(JSON.parse(w.store.file)._rev, 4);
  const again = await w.boot();
  assert.ok(again.bridge.events.some((e) => e.healed === 4), 'hydrate noted the heal: ' + JSON.stringify(again.bridge.events));
  assert.equal(w.store.control.rev, 4, 'control.rev healed from the bytes');
  assert.match(again.banner(), /kept as a snapshot/);
  same(again.bridge.events.filter((e) => e.keepBoth).pop(), { keepBoth: 'generation', fileRev: 4, localRev: 3 });
  assert.equal(again.state().log[0].sessionId, 'sid-0008', 'the file (the imported data) is what loaded');
  assert.equal(JSON.parse(again.bridge.snapshot.bytes).log.length, 3, 'the previous copy is the kept snapshot');
});

test('an interrupted Erase (killed after the first control write) cannot come back through write-through: keep both', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  w.store.killAt = 'afterFirstControl';
  page.ctx.confirmErase(); page.pressModal('Erase everything');
  await sleep(30);
  w.kill();
  const again = await w.boot();
  assert.match(again.banner(), /kept as a snapshot/);
  same(again.bridge.events.filter((e) => e.keepBoth).pop(), { keepBoth: 'generation', fileRev: 3, localRev: 3 });
  assert.equal(w.store.count('save'), 0, 'no write-through');
  assert.equal(JSON.parse(w.store.file).log.length, 3, 'the file is as it was');
});

test('the state write fails after the generation bump: the plugin refuses with the new generation; the page adopts it, says nothing changed, re-sends its copy and keeps saving', async () => {
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
  assert.equal(w.store.generation, 2, 'the bump landed before the failure');
  assert.match(page.modalBody(), /Nothing changed/);
  assert.equal(page.ctx.__sync.quiescing, false, 'guard dropped');
  assert.equal(page.state().log.length, 3, 'local untouched');
  assert.ok(page.bridge.events.some((e) => e.adoptedGeneration === 2));
  assert.equal(page.bridge.generation, 2);
  assert.equal(w.storage.get('train_store_gen'), '2');
  w.store.failAfterDisarm = false;
  await page.settle();
  assert.equal(w.store.rev, 4, 'this screen’s copy was re-sent in the new generation');
  assert.equal(page.bridge.lastCommitted.rev, 4);
  const r = await page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 2 }));
  same(r, { accepted: true, rev: 5 });
  const again = await w.boot();
  assert.equal(again.banner(), null, 'the relaunch is an equal-hash boot in the adopted generation');
});

test('Erase: snapshot, disarm, generation bump, file removed, local key removed, re-seeded at 0, reload lands in the missing-state rule with no banner', async () => {
  const w = seededWorld();
  w.store.syncArmed = true;
  const page = await w.boot();
  await page.settle();
  page.ctx.confirmErase();
  assert.equal(page.modalTitle(), 'Erase all data?');
  await page.pressModal('Erase everything');
  assert.ok(await until(() => w.reloads === 1));
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
  // during the drain the guard is up: a sync attempt is refused and a second transaction does not start
  assert.equal(page.ctx.__sync.quiescing, true);
  same(await page.ctx.pushUnsynced(), { refused: 'quiescing' });
  same(await page.ctx.syncEntry('sid-0001'), { refused: 'quiescing' });
  await assert.rejects(() => page.ctx.postSync({ op: 'delete', sessionId: 'x' }), /quiescing/);
  assert.equal(w.syncRequests.length, 0);
  assert.ok(page.bridge.events.some((e) => e.syncRefused === 'quiescing'));
  page.ctx.importData({ target: { files: [{ text: JSON.stringify(seedState({ log: [entry(9)] })) }] } });
  await sleep(5); await page.pressModal('Import');
  await sleep(5);
  assert.ok(page.bridge.events.some((e) => e.quiesceBusy), 're-entry refused');
  assert.equal(w.store.count('importState'), 0);
  assert.ok(await until(() => page.modalTitle() === 'Still syncing'));
  assert.equal(w.store.count('erase'), 0);
  // the default wait is 10 seconds
  const defaults = new World({ config: {} });
  const d = await defaults.boot();
  same(d.bridge.config, { readRetryMs: 5000, quiesceMs: 10000, exportWaitMs: 3000 });
});

test('the embed probe window is 45 seconds by default and configurable for the tests', async () => {
  const defaults = new World({ config: {} });
  const d = await defaults.boot();
  assert.equal(d.bridge.embedTimeoutMs, 45000);
  const short = new World();
  const s = await short.boot();
  assert.equal(s.bridge.embedTimeoutMs, 300);
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
  // round trip: the export goes back in through Import and survives a relaunch (the same log, ids and fields)
  const before = page.state();
  await importViaUi(page, JSON.parse(w.fsWrites[0].data));
  assert.ok(await until(() => w.reloads === 1), 'the import reloaded');
  assert.equal(w.store.rev, 5, 'committed at file rev + 1');
  assert.equal(w.store.generation, 2);
  const again = await w.boot();
  assert.equal(again.banner(), null);
  same(again.state().log.map((e) => e.sessionId), ['sid-0001', 'sid-0002', 'sid-0003']);
  same(again.state().log, before.log);
  assert.equal(again.state().rotationIndex, 2);
  same(stripped(w.store.file), exported, 'the file holds the exported content byte for byte apart from the stamps');
});

test('snapshots: the pre-import snapshot survives a day of saves (only save snapshots are pruned to 5)', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  await importViaUi(page, seedState({ log: [entry(2)] }));
  assert.ok(await until(() => w.reloads === 1));
  const again = await w.boot();
  for (let i = 0; i < 12; i++) { await again.ctx.saveState(Object.assign(again.state(), { rotationIndex: i % 5 })); }
  const reasons = w.store.snapshots.map((s) => s.reason);
  assert.equal(reasons.filter((r) => r === 'save').length, 5);
  assert.equal(reasons.filter((r) => r === 'import').length, 1, 'the pre-import snapshot is still there: ' + reasons.join(','));
  const kept = w.store.snapshots.find((s) => s.reason === 'import');
  assert.equal(kept.rev, 3); assert.equal(JSON.parse(kept.bytes).log.length, 3);
});

test('log capture: the last 200 console lines ride in a ring; a refusal writes them through appendLog with the events; the summary carries the tail', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  page.ctx.console.error('boom', { code: 7 });
  for (let i = 0; i < 250; i++) page.ctx.console.log('line ' + i);
  assert.equal(page.bridge.logRing.length, 200, 'ring capped');
  assert.ok(page.bridge.logRing.every((l) => /^\d{4}-\d{2}-\d{2}T/.test(l)));
  assert.equal(w.store.count('appendLog'), 0, 'nothing written while all is well');
  const other = JSON.parse(w.store.file); other.rotationIndex = 4; other._base = 3; other._rev = 4;
  w.store.writeExternally(JSON.stringify(other));
  await page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 1 }));
  assert.ok(await until(() => w.store.results('appendLog').length === 1 && w.store.results('appendLog')[0]), 'the refusal banner flushed the log');
  const text = w.store.calls.find((c) => c.method === 'appendLog').args.text;
  assert.match(text, /banner: This copy fell behind/);
  assert.match(text, /log line 249/);
  assert.match(text, /"refused":"stale"/);
  assert.doesNotMatch(text, /boom/, 'the ring kept only the last 200 lines');
  assert.ok(w.store.log.endsWith('\n'));
  const s = await page.ctx.Capacitor.Plugins.TrainStore.summary({});
  assert.equal(s.logTail.length, 3);
  assert.match(s.logTail[2], /^events \[/);
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
  assert.match(page.els['store-loaded'].textContent, /^3 sessions · digest [0-9a-f]{8} loaded$/);
  assert.match(page.els['settings-content'].innerHTML, /Full log as JSON, via the share sheet · 3 sessions · digest [0-9a-f]{8}/, 'the count and digest beside Export');
});

// ---- the smoke fixture path ------------------------------------------------------------------------

test('a launch with -trainFixture imports the bundled synthetic fixture into an empty store, then hydrates from it; a relaunch skips the import', async () => {
  const w = new World();
  w.store.launch = { fixture: 'smoke', smoke: true };
  const page = await w.boot();
  assert.equal(page.banner(), null);
  same(page.bridge.events.filter((e) => e.fixture).map((e) => [e.fixture, e.imported, e.rev, e.generation]), [['smoke', true, 1, 1]]);
  assert.equal(w.store.rev, 1);
  assert.equal(w.store.generation, 1);
  assert.equal(page.state().log.length, 2, 'the two invented sessions are loaded');
  assert.equal(page.state().recovery.on, true);
  assert.match(page.home, /Start Today/);
  const again = await w.boot();
  assert.equal(w.store.count('importState'), 1, 'no second import once the store has a file');
  assert.equal(again.state().log.length, 2);
  assert.equal(again.banner(), null);
});

test('a launch with -trainResetStore empties the WebView storage and the store before the fixture import', async () => {
  const w = seededWorld();
  w.storage.set('train_seed_rev', '3'); w.storage.set('train_store_gen', '1'); w.storage.set('train_state', w.store.file);
  w.store.launch = { fixture: 'smoke', smoke: true, reset: true };
  const page = await w.boot();
  assert.equal(page.banner(), null);
  assert.equal(w.store.count('erase'), 1);
  assert.equal(page.state().log.length, 2, 'the fixture, not the old state');
  assert.equal(w.store.generation, 3, 'erase bumped once, the import once');
});

// ---- parity: cues, one audio path, the sound key, the wake lock polyfill, embeds -------------------

test('cues play natively (audio plus haptic) and are gated on soundEnabled() like toneW and buzz; the shell never vibrates through the web API', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  page.ctx.cueGo(); page.ctx.cueLogged();
  assert.ok(await until(() => w.store.audio.plays === 2));
  same(w.store.calls.filter((c) => c.method === 'cue').map((c) => c.args.name), ['cueGo', 'cueLogged']);
  same(w.haptics, [{ notification: 'SUCCESS' }, { impact: 'LIGHT' }]);
  assert.equal(w.store.audio.lastCue, 'cueLogged');
  assert.equal(w.store.audio.plays, 2);
  // sound off: no audio, no haptic (buzz is gated the same way in the app)
  page.ctx.setSoundEnabled(false);
  assert.equal(page.ctx.soundEnabled(), false);
  assert.equal(w.storage.get('train_sound_off'), '1');
  page.ctx.cueSessionDone(); page.ctx.cueNoted(); page.ctx.cueStarted(); page.ctx.cueRelease();
  await sleep(20);
  assert.equal(w.store.count('cue'), 2, 'nothing played while sound is off');
  assert.equal(w.haptics.length, 2);
  page.ctx.setSoundEnabled(true);
  page.ctx.cueRelease();
  assert.ok(await until(() => w.store.audio.plays === 3));
  same(w.haptics[2], { notification: 'WARNING' });
  assert.equal(w.vibrates, undefined, 'navigator.vibrate is never used');
  // the six names are exactly the app's
  same(['cueGo', 'cueRelease', 'cueStarted', 'cueLogged', 'cueSessionDone', 'cueNoted'].map((n) => typeof page.ctx[n]), Array(6).fill('function'));
});

test('one audio path: unlockAudio and toneW are no-ops and the shell never creates an AudioContext, through a session and the PT list', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  assert.equal(page.audioContexts.length, 0, 'none at boot');
  page.ctx.unlockAudio(); page.ctx.toneW(523, 0, 0.1, 0.3, 'sine');
  // a session: the app's own unlockAudio calls and cues (arm check, Form, Prep, a logged set)
  page.ctx.startSession('RP');
  if (page.modalTitle() === 'Arm check') await page.pressModal('Same');
  page.ctx.advanceForm(); page.ctx.advanceForm();
  if (page.ctx.__AS() && page.ctx.__AS().phase !== 'rest') { try { page.ctx.logRepSet(); } catch (e) { /* a station that is not a rep set */ } }
  await sleep(20);
  page.ctx.discardCurrentSession();
  assert.equal(page.audioContexts.length, 0, 'no AudioContext through a session');
  // PT's list: startPtSession, ptStartItem and ptSetDone call unlockAudio and the cues
  const cuesBefore = w.store.count('cue');
  page.ctx.startPtSession();
  if (page.modalTitle() === 'Arm check') await page.pressModal('Same');
  page.ctx.ptOpen(0);
  page.ctx.ptStartItem();
  await sleep(20);
  if (typeof page.ctx.ptSetDone === 'function') { try { page.ctx.ptSetDone(); } catch (e) { /* a timed step */ } }
  await sleep(20);
  page.ctx.closePtSession();
  assert.equal(page.audioContexts.length, 0, 'no AudioContext through the PT list');
  assert.ok(w.store.count('cue') > cuesBefore, 'the list used the native cue path: ' + (w.store.count('cue') - cuesBefore));
  // the counter is live: a direct construction is counted
  new page.ctx.AudioContext();
  assert.equal(page.audioContexts.length, 1);
});

test('the sound key rides in the control sidecar: the page’s key wins and is pushed to the store when it differs; the store’s value applies only to an evicted WebView; setSoundEnabled writes both; a kill after a toggle keeps the toggle', async () => {
  const w = seededWorld();
  w.store.control.soundOff = true;                   // he turned sound off on an earlier install of this phone
  const page = await w.boot();
  assert.equal(w.storage.get('train_sound_off'), '1', 'an empty WebView takes the store’s copy');
  assert.equal(page.ctx.soundEnabled(), false);
  page.ctx.setSoundEnabled(true);
  assert.equal(w.storage.get('train_sound_off'), '0', 'the app’s own write lands first');
  assert.ok(await until(() => w.store.control.soundOff === false), 'the store follows');
  w.evict();
  const again = await w.boot();
  assert.equal(w.storage.get('train_sound_off'), '0', 'survives eviction through the store');
  assert.equal(again.ctx.soundEnabled(), true);
  // the page's key wins over a store that disagrees, and the store is brought in line
  const w2 = seededWorld();
  w2.store.control.soundOff = false;
  w2.storage.set('train_sound_off', '1');
  const p2 = await w2.boot();
  assert.equal(w2.storage.get('train_sound_off'), '1', 'local untouched');
  assert.equal(p2.ctx.soundEnabled(), false);
  assert.ok(await until(() => w2.store.control.soundOff === true), 'pushed to the store');
  // agreement means no write
  const w3 = seededWorld();
  w3.store.control.soundOff = true; w3.storage.set('train_sound_off', '1');
  await w3.boot(); await sleep(20);
  assert.equal(w3.store.count('setSoundOff'), 0);
  // a kill right after the toggle, before the store write: the relaunch pushes the toggle through
  const w4 = seededWorld();
  const p4 = await w4.boot();
  w4.store.hooks.setSoundOff = async () => new Promise(() => {});   // the write never reaches the plugin
  p4.ctx.toggleSound();
  assert.equal(w4.storage.get('train_sound_off'), '1');
  assert.equal(w4.store.control.soundOff, undefined, 'the store never heard');
  w4.kill(); delete w4.store.hooks.setSoundOff;
  const p5 = await w4.boot();
  assert.equal(p5.ctx.soundEnabled(), false, 'the toggle held');
  assert.ok(await until(() => w4.store.control.soundOff === true), 'and reached the store on relaunch');
  // not in an export
  await p5.ctx.exportData();
  assert.equal('train_sound_off' in JSON.parse(w4.fsWrites[0].data), false);
  assert.equal('soundOff' in JSON.parse(w4.fsWrites[0].data), false);
});

test('Settings in the shell tells the truth about the silent switch (the playback category sounds through it)', async () => {
  const w = seededWorld();
  const page = await w.boot();
  const html = page.settings();
  assert.doesNotMatch(html, /only play when your phone's silent switch is off/);
  assert.match(html, /Cues play with the silent switch on; turn Cue sounds off to silence them\./);
  assert.match(html, /Cue sounds/, 'the toggle is still there');
  assert.match(html, /toggleSound\(\)/, 'with its handler');
});

test('navigator.wakeLock polyfill: request returns a sentinel with release() and a release event; hidden releases it natively; the PT list re-acquires on visible; a native release the page did not see re-acquires too', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  // the contract
  const s = await page.ctx.navigator.wakeLock.request('screen');
  assert.equal(s.type, 'screen'); assert.equal(s.released, false);
  assert.equal(w.store.wake.held, true); assert.equal(w.store.wake.idleTimerDisabled, true); assert.equal(w.store.wake.acquires, 1);
  let events = 0; s.addEventListener('release', () => { events += 1; });
  await s.release();
  assert.equal(events, 1); assert.equal(s.released, true);
  assert.equal(w.store.wake.held, false); assert.equal(w.store.wake.releases, 1);
  await assert.rejects(() => page.ctx.navigator.wakeLock.request('system'), /only screen/);
  // a stale release never clears a newer lock
  const a = await page.ctx.navigator.wakeLock.request('screen');
  const b = await page.ctx.navigator.wakeLock.request('screen');
  await a.release();
  assert.equal(w.store.wake.held, true, 'b still holds the timer');
  await b.release();
  assert.equal(w.store.wake.held, false);
  // the PT list: Start holds the screen; background releases it (hidden event); foreground re-acquires through ptWakeOn
  const acquiresBefore = w.store.wake.acquires;
  page.ctx.startPtSession();
  if (page.modalTitle() === 'Arm check') await page.pressModal('Same');
  page.ctx.ptOpen(0);
  page.ctx.ptStartItem();
  assert.ok(await until(() => w.store.wake.acquires === acquiresBefore + 1), 'ptWakeOn acquired');
  assert.equal(page.wake.sentinels.length, 1);
  assert.equal(w.store.wake.held, true);
  await page.hide();
  assert.equal(page.wake.sentinels.length, 0, 'the sentinel was released on hidden');
  assert.equal(w.store.wake.held, false, 'native released');
  assert.equal(w.store.wake.idleTimerDisabled, false);
  await page.show();
  assert.ok(await until(() => w.store.wake.acquires === acquiresBefore + 2), 're-acquired on visible: ' + JSON.stringify(w.store.wake));
  assert.equal(w.store.wake.held, true);
  assert.equal(page.wake.sentinels.length, 1);
  // native released while the page saw no hidden event: its event releases the sentinel and the app re-acquires
  w.store.background();
  assert.ok(await until(() => w.store.wake.acquires === acquiresBefore + 3), 're-acquired after the native event: ' + JSON.stringify(w.store.wake));
  assert.equal(page.wake.listener, 'plugin');
  assert.ok(page.bridge.events.some((e) => e.nativeWakeReleased !== undefined && e.released === 1));
  // the native event re-acquires only while the app's own condition holds: paused, it does not
  page.ctx.__PTS().run.paused = true;
  w.store.background();
  await sleep(30);
  assert.equal(page.wake.sentinels.length, 0, 'the sentinel was released');
  assert.equal(w.store.wake.acquires, acquiresBefore + 3, 'no re-acquire while paused');
  page.ctx.__PTS().run.paused = false;
  // closing the list releases
  page.ctx.closePtSession();
  assert.ok(await until(() => w.store.wake.held === false));
  assert.equal(page.wake.sentinels.length, 0);
  // hydration releases whatever a previous page held
  w.store.wake.held = true; w.store.wake.idleTimerDisabled = true;
  await w.boot();
  assert.equal(w.store.wake.held, false, 'released on hydration');
  assert.equal(w.store.wake.lastRelease, 'all');
});

test('wake lock sentinels: two live sentinels keep native held until both are released; a native event releases only the sentinels it covered; an acquire that resolves on a hidden page is given back', async () => {
  const w = seededWorld();
  const page = await w.boot();
  await page.settle();
  const wl = page.ctx.navigator.wakeLock;
  // two live sentinels: releasing the newer one keeps native held for the older
  const older = await wl.request('screen');
  const newer = await wl.request('screen');
  assert.equal(w.store.wake.token, 2);
  const releasesBefore = w.store.wake.releases;
  await newer.release();
  assert.equal(newer.released, true); assert.equal(older.released, false);
  assert.equal(w.store.wake.held, true, 'native still held for the older sentinel');
  assert.equal(w.store.wake.releases, releasesBefore, 'no native release yet');
  await older.release();
  assert.equal(w.store.wake.held, false, 'released once none remain');
  assert.equal(w.store.wake.releases, releasesBefore + 1);
  // a native event covers only the sentinels acquired before it: a sentinel acquired after stays live
  const a = await wl.request('screen');                       // token 3
  w.store.background();                                       // releases token 3, bumps to 4, event token 4
  await sleep(10);
  assert.equal(a.released, true);
  const b = await wl.request('screen');                       // token 5
  w.store.wakeListeners.forEach((fn) => fn({ token: 4, reason: 'late' }));   // a late copy of the earlier event
  assert.equal(b.released, false, 'a sentinel acquired after the release is not touched by its event');
  assert.equal(w.store.wake.held, true);
  await b.release();
  // an acquire that resolves while the page is hidden is released and rejected
  w.store.delays.wakeAcquire = 40;
  const pending = wl.request('screen');
  await sleep(5);
  page.hideOnly();
  await assert.rejects(() => pending, /hidden/);
  await sleep(10);
  assert.equal(w.store.wake.held, false, 'given back to native');
  assert.equal(page.wake.sentinels.length, 0);
  assert.ok(page.bridge.events.some((e) => e.wakeAcquireWhileHidden));
  page.showOnly();
  delete w.store.delays.wakeAcquire;
  // a request while hidden is refused outright
  page.hideOnly();
  await assert.rejects(() => wl.request('screen'), /hidden/);
  page.showOnly();
});

test('embeds: buildEmbedUrl points YouTube at the https wrapper on Pages (Vimeo unchanged); the reference modal uses it; the wrapper’s postMessage states are recorded; the uiTest button probes the wrapper', async () => {
  const w = seededWorld();
  w.store.launch = { fixture: null, smoke: false, reset: false, uiTest: true };
  const page = await w.boot();
  await page.settle();
  assert.equal(page.ctx.buildEmbedUrl({ mediaType: 'youtube', videoId: 'abc-123', start: 5, end: 9 }), 'https://hyndesyte.github.io/train/embed.html?yt=abc-123&start=5&end=9');
  assert.equal(page.ctx.buildEmbedUrl({ mediaType: 'youtube', videoId: 'abc' }), 'https://hyndesyte.github.io/train/embed.html?yt=abc');
  assert.equal(page.ctx.buildEmbedUrl({ mediaType: 'vimeo', videoId: '123', start: 4 }), 'https://player.vimeo.com/video/123?playsinline=1&title=0&byline=0&portrait=0#t=4s');
  assert.equal(page.ctx.buildEmbedUrl({ mediaType: 'youtube' }), null);
  page.ctx.showRefFor('Clip', { status: 'video', mediaType: 'youtube', videoId: 'abc', fallbackUrl: 'https://www.youtube.com/watch?v=abc' }, 'cue');
  assert.match(page.modalHtml(), /<iframe src="https:\/\/hyndesyte\.github\.io\/train\/embed\.html\?yt=abc"/);
  assert.match(page.modalHtml(), /Open source/, 'the Safari link is there as the fallback');
  page.postMessage({ type: 'train-embed', state: 'loaded', id: 'abc' });
  page.postMessage({ type: 'train-embed', state: 'ready', id: 'abc' });
  assert.equal(page.bridge.embed.state, 'ready');
  assert.equal(page.bridge.embed.origin, 'https://hyndesyte.github.io');
  page.postMessage({ type: 'other' });
  assert.equal(page.bridge.embed.state, 'ready', 'unrelated messages are ignored');
  page.postMessage({ type: 'train-embed', state: 'error', code: 999, id: 'abc' }, 'https://evil.example');
  assert.equal(page.bridge.embed.state, 'ready', 'a message from another origin is ignored');
  assert.ok(page.bridge.events.some((e) => e.embedMessageIgnored === 'https://evil.example'));
  assert.ok(await until(() => w.store.testNotes.embed && w.store.testNotes.embed.state === 'ready'), 'the test summary carries it');
  // the uiTest button: Settings offers it, it opens the modal on the known video and probes the wrapper
  assert.match(page.settings(), /Embed test/);
  page.els['store-embed-test'].onclick();
  assert.match(page.modalHtml(), /embed\.html\?yt=M7lc1UVf-VE/);
  assert.ok(await until(() => w.store.testNotes.embed && w.store.testNotes.embed.wrapper === 200), JSON.stringify(w.store.testNotes));
  page.postMessage({ type: 'train-embed', state: 'error', code: 153, id: 'M7lc1UVf-VE' });
  assert.equal(page.bridge.embed.code, 153);
  // a player that never reports is recorded as a timeout (short in the tests)
  page.els['store-embed-test'].onclick();
  assert.ok(await until(() => page.bridge.embed.state === 'timeout:opening', 1500), page.bridge.embed.state);
  // a launch without the test flag has no button
  const w2 = seededWorld();
  const p2 = await w2.boot();
  assert.doesNotMatch(p2.settings(), /Embed test/);
});
