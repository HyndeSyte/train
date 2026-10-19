#!/usr/bin/env node
// Copy step for the native shell. Copies the served PWA files from the repo root into native/www
// and patches the shell's OWN copy of index.html in exactly two places (plan v4, principle 2):
//   1. the awaited ready-hook as the first statement inside the DOMContentLoaded handler;
//   2. one <script src="bridge.js"></script> line after the inline script.
// The live index.html, data.js and style.css are never written. writer.json is never copied: the
// shell is never handed off and never reads the flag. Exits non-zero unless both patches applied
// exactly once.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HANDLER = "document.addEventListener('DOMContentLoaded', async ()=>{\n";
const HOOK = "  await (window.__trainReady ? window.__trainReady() : Promise.resolve());   // shell ready-hook, added by the copy step\n";
const TAIL = '</script>\n</body>\n</html>';
const BRIDGE_TAG = '<script src="bridge.js"></script>';
export const COPIED = ['index.html', 'data.js', 'style.css'];   // everything index.html references; writer.json excluded on purpose

function countOf(hay, needle) { return hay.split(needle).length - 1; }

export function patchIndex(html) {
  if (countOf(html, HANDLER) !== 1) throw new Error(`copy-www: expected one DOMContentLoaded handler, found ${countOf(html, HANDLER)}`);
  if (countOf(html, TAIL) !== 1) throw new Error(`copy-www: expected one inline-script tail, found ${countOf(html, TAIL)}`);
  if (html.includes(BRIDGE_TAG) || html.includes('__trainReady')) throw new Error('copy-www: source already patched');
  const out = html
    .replace(HANDLER, HANDLER + HOOK)
    .replace(TAIL, `</script>\n${BRIDGE_TAG}\n</body>\n</html>`);
  assertPatched(out);
  return out;
}

export function assertPatched(html) {
  const hookLines = countOf(html, HOOK);
  const tags = countOf(html, BRIDGE_TAG);
  if (hookLines !== 1) throw new Error(`copy-www: ready-hook applied ${hookLines} times`);
  if (tags !== 1) throw new Error(`copy-www: bridge.js tag applied ${tags} times`);
  // the hook is the first statement of the handler
  const idx = html.indexOf(HANDLER);
  if (html.slice(idx + HANDLER.length, idx + HANDLER.length + HOOK.length) !== HOOK) throw new Error('copy-www: ready-hook is not the first statement');
  return true;
}

// Synthetic fixtures for the CI smoke test ride along under www/fixtures (bundled, never real data).
export function copyWww({ root, dest, fixturesDir }) {
  mkdirSync(dest, { recursive: true });
  const written = [];
  for (const name of COPIED) {
    const src = join(root, name);
    const out = join(dest, name);
    if (name === 'index.html') writeFileSync(out, patchIndex(readFileSync(src, 'utf8')));
    else copyFileSync(src, out);
    written.push(out);
  }
  const fx = fixturesDir || join(root, 'native', 'test', 'fixtures');
  if (existsSync(fx)) {
    mkdirSync(join(dest, 'fixtures'), { recursive: true });
    for (const f of readdirSync(fx).filter((n) => n.endsWith('.json')).sort()) {
      const out = join(dest, 'fixtures', f);
      copyFileSync(join(fx, f), out);
      written.push(out);
    }
  }
  return written;
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const root = resolve(here, '..', '..');          // repo root (the served PWA)
  const dest = resolve(here, '..', 'www');         // native/www (bridge.js lives here, committed)
  const written = copyWww({ root, dest });
  assertPatched(readFileSync(join(dest, 'index.html'), 'utf8'));
  console.log('copy-www: ' + written.map((w) => w.replace(root + '/', '')).join(', ') + ' (index.html patched: ready-hook + bridge.js)');
}
