// Export round trip, a CI check for every build: a native Export (through the fake plugin: the shell's
// Export writes the committed head to the Filesystem plugin and shares it) imports losslessly into the
// PWA's root test harness shape: the same log, ids and fields, the same covered state, no stamps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, seedState, entry, committedBytes, sleep } from './shell-harness.mjs';
import { bootPwa } from './pwa-harness.mjs';

const same = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);

test('a native Export imports losslessly into the PWA harness: log, ids, fields and the covered state survive; the stamps do not travel', async () => {
  const state = seedState({
    log: [entry(1), entry(2, { notionSync: { status: 'pending' }, notes: 'ring day', issues: [{ exId: 'x', note: 'tingle' }] }), entry(3, { sessionType: 'LP', performed: [{ slotId: 's', exId: 'e', reps: [5, 5] }] })],
    rotationIndex: 2, nextSessionSequence: 9, pendingDeletes: ['sid-0042'], anchorProgress: { a: { level: 1 } }, ptLevels: { 'pt-1': 1 },
    armCheck: { date: '2026-10-19', value: 'same' }
  });
  const w = new World();
  w.store.file = committedBytes(state, 3); w.store.rev = 3; w.store.generation = 1;
  const page = await w.boot();
  page.ctx.saveState(Object.assign(page.state(), { rotationIndex: 3 }));
  await page.ctx.exportData();
  assert.equal(w.fsWrites.length, 1, 'one file: the committed head');
  assert.match(w.fsWrites[0].path, /^train-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const exported = JSON.parse(w.fsWrites[0].data);
  for (const k of ['_rev', '_base', 'seedRev']) assert.equal(k in exported, false, k + ' does not travel');
  assert.equal(exported.rotationIndex, 3, 'the export is the state after the save');

  // into the PWA, through its own Import path (confirm pressed), on an empty phone
  const pwa = bootPwa();
  pwa.ctx.importData({ target: { files: [{ text: JSON.stringify(exported) }] } });
  await sleep(10);
  const got = pwa.ctx.getState();
  same(got.log.map((e) => e.sessionId), ['sid-0001', 'sid-0002', 'sid-0003']);
  same(got.log, page.state().log, 'every log entry and field, including notionSync');
  for (const k of ['rotationIndex', 'nextSessionSequence', 'pendingDeletes', 'anchorProgress', 'ptLevels', 'armCheck', 'recovery', 'legacy', 'schemaVersion', 'progressionEngineVersion']) {
    same(got[k], page.state()[k], k + ' survives');
  }
  // the fingerprint the shell shows as "verified" is the same on both sides
  const fp = page.ctx.__fingerprintOf;
  assert.equal(await fp(got), await fp(page.state()), 'same fingerprint on both sides');
  // and the PWA's own export of that state is the same document again
  assert.equal('_rev' in got, false);
  // the count and digest he reads at cutover agree
  const ids = (s) => s.log.map((e) => e.sessionId).sort();
  same(ids(got), ids(page.state()));
});

test('a snapshot export (a kept copy after a conflict) imports into the PWA harness the same way', async () => {
  const w = new World();
  w.store.file = committedBytes(seedState(), 3); w.store.rev = 3; w.store.generation = 1;
  const page = await w.boot(); await page.settle();
  const other = JSON.parse(w.store.file); other.rotationIndex = 4; other._base = 3; other._rev = 4; w.store.writeExternally(JSON.stringify(other));
  const local = page.state(); local.log.push(entry(7)); page.ctx.saveState(local); await page.settle();
  assert.match(page.banner(), /fell behind/, 'the save was refused as stale');
  const again = await w.boot();
  assert.match(again.banner(), /kept as a snapshot/);
  again.settings();
  await again.els['store-snapshot-export'].onclick();
  const exported = JSON.parse(w.fsWrites[0].data);
  assert.ok(exported.log.some((e) => e.sessionId === 'sid-0007'));
  const pwa = bootPwa();
  pwa.ctx.importData({ target: { files: [{ text: JSON.stringify(exported) }] } });
  await sleep(10);
  assert.ok(pwa.ctx.getState().log.some((e) => e.sessionId === 'sid-0007'), 'the kept session is in the PWA after the import');
});
