// R1: no session block is labeled "Core" (that word means the v7 core gate path, not a body part).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('RPr finisher reads "Trunk"; no template block in either mode is labeled "Core"', () => {
  const ctx = { window: {} }; ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(readFileSync(join(root, 'data.js'), 'utf8'), ctx);
  const normal = ctx.SESSION_TEMPLATES, recovery = ctx.RECOVERY_TEMPLATES;
  assert.ok(normal && normal.RPr, 'templates loaded');
  const rprFinisher = normal.RPr.blocks.find((b) => b.exercises.includes('hanging-knee-raise'));
  assert.equal(rprFinisher.label, 'Trunk');
  for (const [name, set] of [['normal', normal], ['recovery', recovery]]) {
    for (const [type, t] of Object.entries(set || {})) {
      for (const b of t.blocks || []) assert.notEqual(b.label, 'Core', `${name} ${type} block labeled Core`);
    }
  }
});
