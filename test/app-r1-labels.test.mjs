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

test('index.html loads data.js with a cache-buster equal to the data version', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const ctx = { window: {} }; ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(readFileSync(join(root, 'data.js'), 'utf8'), ctx);
  const m = /<script src="data\.js\?v=([^"]+)"><\/script>/.exec(html);
  assert.ok(m, 'data.js script tag with a version query');
  assert.equal(m[1], ctx.TRAIN_DATA_VERSION, 'cache-buster matches TRAIN_DATA_VERSION');
});
