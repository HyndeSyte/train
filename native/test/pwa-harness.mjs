// The PWA's root test harness shape (test/app-*.test.mjs at the repo root): the UNPATCHED index.html
// and data.js in a stubbed-DOM vm context, no bridge.js, no plugins. What a native export must import
// into losslessly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { root } from './shell-harness.mjs';

// the PWA root test harness shape (test/app-*.test.mjs): the unpatched index.html, no bridge
export function bootPwa(seed) {
  const els = {};
  const storage = new Map(seed ? [['train_state', JSON.stringify(seed)]] : []);
  const makeEl = () => ({ innerHTML: '', textContent: '', value: '', checked: false, style: {}, onclick: null, classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, f) { if (f === undefined) f = !this._s.has(c); f ? this._s.add(c) : this._s.delete(c); return f; } } });
  const documentStub = { getElementById(id) { if (!els[id]) els[id] = makeEl(); return els[id]; }, querySelectorAll() { return []; }, addEventListener() {}, createElement() { return makeEl(); }, body: { addEventListener() {}, innerHTML: '' } };
  class FakeFileReader { readAsText(f) { this.onload({ target: { result: f.text } }); } }
  const ctx = {
    localStorage: { getItem: (k) => storage.has(k) ? storage.get(k) : null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    document: documentStub, navigator: {}, console, setTimeout, clearTimeout,
    Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Promise, crypto: undefined,
    alert() {}, prompt() { return null; }, confirm() { return true; },
    fetch() { return Promise.reject(new Error('no network in tests')); },
    URL: { createObjectURL() { return ''; }, revokeObjectURL() {} }, Blob: class {}, FileReader: FakeFileReader
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(root, 'data.js'), 'utf8'), ctx);
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const m = /<script>\n([\s\S]*)\n<\/script>/.exec(html);
  assert.ok(m, 'inline app script found');
  vm.runInContext(m[1], ctx);
  // the PWA's import confirms through its modal: press Import if one is showing
  const origImport = ctx.importData;
  ctx.importData = (ev) => { origImport(ev); const b = els['mb-Import']; if (b && b.onclick) b.onclick(); };
  return { ctx, els, storage };
}

