// The copy step patches the shell's own copy of index.html exactly twice and copies the other
// served files unchanged; it never writes to the repo root.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyWww, patchIndex, assertPatched, COPIED } from '../scripts/copy-www.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('copy: the three served files land in the destination; index.html is patched; writer.json is not copied', () => {
  const before = Object.fromEntries(COPIED.map((n) => [n, statSync(join(root, n)).mtimeMs]));
  const dest = mkdtempSync(join(tmpdir(), 'train-www-'));
  const written = copyWww({ root, dest });
  assert.deepEqual(written.map((w) => w.replace(dest + '/', '')).sort(), [...COPIED, 'fixtures/smoke.json'].sort());
  assert.equal(JSON.parse(readFileSync(join(dest, 'fixtures', 'smoke.json'), 'utf8')).log.length, 2, 'the synthetic smoke fixture rides along');
  assert.equal(existsSync(join(dest, 'writer.json')), false);
  for (const n of COPIED) assert.equal(statSync(join(root, n)).mtimeMs, before[n], n + ' at the repo root untouched');
  const html = readFileSync(join(dest, 'index.html'), 'utf8');
  assert.ok(assertPatched(html));
  assert.equal(readFileSync(join(dest, 'data.js'), 'utf8'), readFileSync(join(root, 'data.js'), 'utf8'));
  assert.equal(readFileSync(join(dest, 'style.css'), 'utf8'), readFileSync(join(root, 'style.css'), 'utf8'));
  // the live file is not patched
  const live = readFileSync(join(root, 'index.html'), 'utf8');
  assert.equal(live.includes('bridge.js'), false);
  assert.equal(live.includes('__trainReady'), false);
});

test('patch: exactly one ready-hook as the first statement of the handler, one bridge.js tag; refuses a double patch', () => {
  const live = readFileSync(join(root, 'index.html'), 'utf8');
  const once = patchIndex(live);
  const handlerIdx = once.indexOf("document.addEventListener('DOMContentLoaded', async ()=>{\n");
  assert.ok(handlerIdx > 0);
  assert.match(once.slice(handlerIdx, handlerIdx + 200), /async \(\)=>\{\n  await \(window\.__trainReady \? window\.__trainReady\(\) : Promise\.resolve\(\)\);/);
  assert.equal(once.split('<script src="bridge.js"></script>').length - 1, 1);
  assert.ok(once.endsWith('</script>\n<script src="bridge.js"></script>\n</body>\n</html>\n'));
  assert.throws(() => patchIndex(once), /already patched/);
  assert.throws(() => patchIndex(live.replace("document.addEventListener('DOMContentLoaded', async ()=>{\n", '')), /expected one DOMContentLoaded handler/);
});
