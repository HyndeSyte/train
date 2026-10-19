// Lane C (one-dumbbell leg work; merges only once PT confirms the 25 lb lift): the two recovery
// leg gates carry a one-dumbbell-at-the-chest rung and cue; no recovery upper-body entry does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ctx = { window: {} }; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(join(root, 'data.js'), 'utf8'), ctx);
const lib = ctx.window.EXERCISE_LIBRARY;
const rec = ctx.window.RECOVERY_TEMPLATES;

test('the two recovery leg gates carry the one-dumbbell rung and cue, bodyweight first', () => {
  for (const id of ['rec-split-squat', 'rec-cossack']) {
    const ex = lib[id];
    assert.ok(ex, id);
    assert.match(ex.ladder[0], /bodyweight/i, id + ' starts at bodyweight');
    assert.match(ex.ladder[1], /one dumbbell at the chest/, id + ' second rung is the dumbbell');
    assert.match(ex.reference.cue, /one dumbbell held at the chest with both hands/, id + ' cue');
    assert.match(ex.reference.cue, /25 lb/, id + ' names PT’s gate');
    assert.match(ex.reference.cue, /Bodyweight on a day the arm check says worse/, id + ' keeps the worse-day rule');
    assert.equal(ex.grip, 'low', id + ' grip reflects the chest hold');
  }
  assert.equal(rec.LP.blocks.find(b => b.gate).exercises[0], 'rec-split-squat');
  assert.equal(rec.LS.blocks.find(b => b.gate).exercises[0], 'rec-cossack');
});

test('no recovery upper-body or core entry gained a dumbbell; nothing says the pair', () => {
  const legs = new Set(['rec-split-squat', 'rec-cossack']);
  for (const [id, ex] of Object.entries(lib)) {
    if (!id.startsWith('rec-') || legs.has(id)) continue;
    const text = [ex.name, ...(ex.ladder || []), ex.reference && ex.reference.cue].join(' ');
    assert.doesNotMatch(text, /one dumbbell/i, id);
  }
  for (const id of legs) assert.doesNotMatch(lib[id].reference.cue, /pair of dumbbells|both dumbbells|two dumbbells/i, id);
});
