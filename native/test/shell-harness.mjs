// Harness for the shell's JS: loads data.js, the PATCHED copy of index.html (from the copy step, in a
// temp dir) and bridge.js in a vm context, with a fake TrainStore that keeps the same compare-and-swap
// and generation semantics as the Swift plugin, plus Filesystem and Share fakes. One `World` is one
// phone: its store (the file) and its WebView storage persist across boots; `boot()` is a launch,
// `kill()` just drops the page, `evict()` wipes the WebView storage.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { copyWww } from '../scripts/copy-www.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const nativeDir = join(root, 'native');
let patchedDir = null;
export function patched() {
  if (!patchedDir) { patchedDir = mkdtempSync(join(tmpdir(), 'train-shell-')); copyWww({ root, dest: patchedDir }); }
  return patchedDir;
}
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the fake native store (same rules as TrainStore.swift) ----------------------------------
// The file (`file`) and the control sidecar (`control`: generation, rev, syncArmed, ...) are separate,
// written in the Swift order: a save writes the state then the control rev; Import and Erase write the
// control first (syncArmed false, generation + 1, rev unchanged), then the state, then the control rev.
// `killAt` models the app dying between those writes (the call never answers; see World.kill()).
export class FakeStore {
  constructor() {
    this.file = null;
    this.control = { generation: 0, rev: 0, syncArmed: false, recoveredFrom: null, committedAt: null };
    this.snapshots = []; this.calls = []; this.events = []; this.log = '';
    this.delays = {};            // method -> ms
    this.hooks = {};             // method -> fn(args) returning a result to use instead, or throwing
    this.holdAcks = {};          // method -> array of resolvers; a held ack settles only on release()
    this.queue = Promise.resolve();
    this.launch = { fixture: null, smoke: false, reset: false, uiTest: false, probeTombstone: false, probeClient: 'pwa' };
    this.failAfterDisarm = false; // the state write fails after the first control write: the plugin answers refuse('write')
    this.killAt = null;           // 'afterFirstControl' | 'afterState': the app dies inside Import/Erase, nothing answers
    // parity: the idle timer (generation token), native cues and the audio session, the sound key, test notes
    this.wake = { held: false, token: 0, acquires: 0, releases: 0, lastRelease: null, idleTimerDisabled: false };
    this.audio = { category: 'AVAudioSessionCategoryPlayback', options: ['mixWithOthers'], active: false, plays: 0, failures: 0, lastCue: null, playing: 0 };
    this.cueMs = 0;               // how long a cue "plays" before the session is restored
    this.testNotes = {};
    this.wakeListeners = [];
  }
  // native releases the idle timer when the app backgrounds and tells the page (notifyListeners)
  background() {
    if (this.wake.held) { this.releaseWake(null, 'background'); const data = { token: this.wake.token, reason: 'background' }; this.wakeListeners.forEach((fn) => fn(data)); }
  }
  releaseWake(token, reason) {
    if (token != null && token !== this.wake.token) return false;
    if (!this.wake.held) return false;
    this.wake.held = false; this.wake.releases += 1; this.wake.lastRelease = reason; this.wake.token += 1; this.wake.idleTimerDisabled = false;
    return true;
  }
  get soundOff() { return this.control.soundOff; } set soundOff(v) { this.control.soundOff = v; }
  get rev() { return this.control.rev; } set rev(v) { this.control.rev = v; }
  get generation() { return this.control.generation; } set generation(v) { this.control.generation = v; }
  get syncArmed() { return this.control.syncArmed; } set syncArmed(v) { this.control.syncArmed = v; }
  get recoveredFrom() { return this.control.recoveredFrom; } set recoveredFrom(v) { this.control.recoveredFrom = v; }
  get committedAt() { return this.control.committedAt; } set committedAt(v) { this.control.committedAt = v; }
  writeControl(patch) { this.control = { ...this.control, ...patch }; this.events.push({ control: { ...this.control } }); }
  parse(bytes) { try { const o = JSON.parse(bytes); return (o && typeof o === 'object') ? o : null; } catch { return null; } }
  revOf(bytes) { const o = this.parse(bytes); return o && typeof o._rev === 'number' ? o._rev : null; }
  hash() { return this.file == null ? null : sha256(this.file); }
  // the last 5 save snapshots and, untouched by saves, the last 3 import/erase snapshots
  snapshot(reason) {
    if (this.file == null) return;
    this.snapshots.unshift({ rev: this.rev, reason, bytes: this.file });
    const isTx = (s) => s.reason === 'import' || s.reason === 'erase';
    const tx = this.snapshots.filter(isTx).slice(0, 3), saves = this.snapshots.filter((s) => !isTx(s)).slice(0, 5);
    this.snapshots = this.snapshots.filter((s) => tx.includes(s) || saves.includes(s));
  }
  hang() { return new Promise(() => {}); }
  // serial queue like the Swift side; each call is logged with its result; delays and hooks are per method
  run(method, args, fn) {
    const entry = { method, args, result: undefined };
    this.calls.push(entry);
    // a hook stands in for a call that never reaches the plugin (or fails on the way): it does not
    // occupy the serial queue, so later calls still run
    if (this.hooks[method]) return Promise.resolve().then(() => this.hooks[method](args)).then((r) => { entry.result = r; return r; });
    const p = this.queue.then(async () => {
      if (this.delays[method]) await sleep(this.delays[method]);
      const r = await fn();
      entry.result = r;
      return r;
    });
    this.queue = p.catch(() => {});
    if (this.holdAcks[method]) {
      return p.then((r) => new Promise((resolve) => { this.holdAcks[method].push(() => resolve(r)); }));
    }
    return p;
  }
  release(method) { const list = this.holdAcks[method] || []; delete this.holdAcks[method]; list.forEach((f) => f()); }
  plugin() {
    const self = this;
    return {
      ping: (a) => self.run('ping', a, async () => ({ pong: a && a.echo, rev: self.rev })),
      report: (a) => self.run('report', a, async () => ({ stored: true })),
      launchOptions: (a) => self.run('launchOptions', a, async () => ({ ...self.launch })),
      addListener: (eventName, cb) => { if (eventName === 'wakeReleased') self.wakeListeners.push(cb); return { remove() { self.wakeListeners = self.wakeListeners.filter((f) => f !== cb); } }; },
      wakeAcquire: (a) => self.run('wakeAcquire', a, async () => { self.wake.token += 1; self.wake.held = true; self.wake.acquires += 1; self.wake.idleTimerDisabled = true; return { ok: true, token: self.wake.token }; }),
      wakeRelease: (a) => self.run('wakeRelease', a, async () => ({ ok: true, released: self.releaseWake(a && typeof a.token === 'number' ? a.token : null, a && typeof a.token === 'number' ? 'sentinel' : 'all') })),
      cue: (a) => self.run('cue', a, async () => {
        const au = self.audio;
        if (!a || !a.name) { au.failures += 1; return { ok: false, error: 'no cue' }; }
        au.options = ['mixWithOthers', 'duckOthers']; au.active = true; au.playing += 1; au.plays += 1; au.lastCue = a.name;
        setTimeout(() => { au.playing = Math.max(0, au.playing - 1); if (au.playing === 0) { au.options = ['mixWithOthers']; au.active = false; au.deactivations = (au.deactivations || 0) + 1; au.lastDeactivation = 'notifyOthersOnDeactivation'; } }, self.cueMs);
        return { ok: true, ...au };
      }),
      setSoundOff: (a) => self.run('setSoundOff', a, async () => { self.writeControl({ soundOff: !!(a && a.off) }); return { ok: true, soundOff: self.control.soundOff }; }),
      setVerified: (a) => self.run('setVerified', a, async () => { let v = null; try { v = JSON.parse(a.json); } catch { return { ok: false }; } self.writeControl({ verified: v }); return { ok: true }; }),
      testNote: (a) => self.run('testNote', a, async () => { Object.assign(self.testNotes, JSON.parse(a.json)); return { ok: true }; }),
      read: (a) => self.run('read', a, async () => {
        const base = () => ({ generation: self.generation, recoveredFrom: self.recoveredFrom, syncArmed: self.syncArmed, soundOff: self.control.soundOff == null ? null : self.control.soundOff, verified: self.control.verified || null });
        if (self.file == null) {
          const healed = self.rev !== 0; if (healed) self.writeControl({ rev: 0 });
          return { rev: 0, hasFile: false, hash: null, ...base(), ...(healed ? { healed: true } : {}) };
        }
        if (self.parse(self.file)) {
          // the bytes are the truth: a control rev left behind by a kill between two writes is healed
          const r = self.revOf(self.file); const healed = r != null && r !== self.rev; if (healed) self.writeControl({ rev: r });
          return { rev: self.rev, hasFile: true, hash: self.hash(), bytes: self.file, ...base(), ...(healed ? { healed: true } : {}) };
        }
        // snapshot recovery: newest valid snapshot, generation bump, recoveredFrom
        self.events.push({ corruptFile: true });
        const good = self.snapshots.find((s) => self.parse(s.bytes));
        self.generation += 1;
        if (good) { self.file = good.bytes; self.rev = self.revOf(good.bytes) || 0; self.recoveredFrom = 'snapshot-r' + good.rev; return { rev: self.rev, generation: self.generation, hasFile: true, hash: self.hash(), bytes: self.file, recoveredFrom: self.recoveredFrom, syncArmed: self.syncArmed, recovered: true }; }
        self.file = null; self.rev = 0; self.recoveredFrom = 'none';
        return { rev: 0, generation: self.generation, hasFile: false, hash: null, recoveredFrom: self.recoveredFrom, syncArmed: self.syncArmed, recovered: true };
      }),
      save: (a) => self.run('save', a, async () => {
        const refuse = (reason) => ({ accepted: false, reason, rev: self.rev, generation: self.generation, hash: self.hash() });
        if (a.generation !== self.generation) return refuse('generation');
        const newRev = self.revOf(a.bytes);
        if (newRev == null || !(newRev > a.base)) return refuse('invalid');
        if (a.base !== self.rev) return refuse('stale');
        self.snapshot('save');
        self.file = a.bytes;                                             // 1. the state
        self.writeControl({ rev: newRev, committedAt: new Date().toISOString() });   // 2. the control rev
        self.events.push({ saved: newRev });
        return { accepted: true, rev: self.rev, generation: self.generation, hash: self.hash() };
      }),
      importState: (a) => self.run('importState', a, async () => {
        const refuse = (reason) => ({ accepted: false, reason, rev: self.rev, generation: self.generation });
        const newRev = self.revOf(a.bytes);
        if (newRev == null) return refuse('invalid');
        if (typeof a.base === 'number' && a.base !== self.rev) return refuse('stale');
        if (newRev !== self.rev + 1) return refuse('invalid');
        self.snapshot('import');
        // 1. disarm, bump the generation and drop the previous Import's record in one control write, rev unchanged
        self.writeControl({ syncArmed: false, generation: self.generation + 1, verified: null });
        self.events.push({ disarmed: true, before: 'import' });
        if (self.killAt === 'afterFirstControl') return self.hang();
        if (self.failAfterDisarm) return refuse('write');
        self.file = a.bytes;                                             // 2. the state at rev + 1
        if (self.killAt === 'afterState') return self.hang();
        self.writeControl({ rev: newRev, committedAt: new Date().toISOString() });   // 3. the control rev
        self.events.push({ imported: newRev, generation: self.generation });
        return { accepted: true, rev: self.rev, generation: self.generation, hash: self.hash() };
      }),
      erase: (a) => self.run('erase', a, async () => {
        self.snapshot('erase');
        self.writeControl({ syncArmed: false, generation: self.generation + 1, verified: null });
        self.events.push({ disarmed: true, before: 'erase' });
        if (self.killAt === 'afterFirstControl') return self.hang();
        if (self.failAfterDisarm) return { accepted: false, reason: 'write', rev: self.rev, generation: self.generation };
        self.file = null;
        if (self.killAt === 'afterState') return self.hang();
        self.writeControl({ rev: 0, committedAt: new Date().toISOString() });
        self.events.push({ erased: true, generation: self.generation });
        return { accepted: true, rev: 0, generation: self.generation, hash: null };
      }),
      status: (a) => self.run('status', a, async () => ({ rev: self.rev, generation: self.generation, committedAt: self.committedAt, syncArmed: self.syncArmed, recoveredFrom: self.recoveredFrom, hasFile: self.file != null, snapshots: self.snapshots.length, soundOff: self.control.soundOff == null ? null : self.control.soundOff, verified: self.control.verified || null, wake: { ...self.wake }, audio: { ...self.audio }, bridge: { ...self.testNotes } })),
      summary: (a) => self.run('summary', a, async () => { const o = self.parse(self.file) || {}; const log = o.log || []; const last = log[log.length - 1]; return { rev: self.rev, generation: self.generation, hasFile: self.file != null, sessions: log.length, sessionIds: log.map((e) => e.sessionId), lastSessionId: last && last.sessionId, logTail: self.logTail(3), syncArmed: self.syncArmed }; }),
      setSyncArmed: (a) => self.run('setSyncArmed', a, async () => { self.writeControl({ syncArmed: !!a.on }); return { ok: true, syncArmed: self.syncArmed }; }),
      // Library/Logs/train.log in Swift: appended, rotated at 200 KB
      appendLog: (a) => self.run('appendLog', a, async () => { if (self.log.length > 200 * 1024) { self.logRotated = self.log; self.log = ''; } self.log += (a.text.endsWith('\n') ? a.text : a.text + '\n'); return { ok: true }; })
    };
  }
  logTail(n) { return this.log.split('\n').filter(Boolean).slice(-n).map((l) => l.slice(0, 200)); }
  // test-side mutations standing in for "another writer" or disk damage
  writeExternally(bytes) { this.snapshot('external'); this.file = bytes; this.rev = this.revOf(bytes) || 0; this.events.push({ external: this.rev }); }
  corrupt() { this.file = '{"schemaVersion":8,"log":[' ; }
  count(method) { return this.calls.filter((c) => c.method === method).length; }
  results(method) { return this.calls.filter((c) => c.method === method).map((c) => c.result); }
}

// ---- the page ---------------------------------------------------------------------------------
function makeEl(registry, tag) {
  const el = {
    tag, id: '', className: '', innerHTML: '', textContent: '', value: '', hidden: false, style: {}, attrs: {}, onclick: null, onchange: null, children: [],
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, f) { if (f === undefined) f = !this._s.has(c); f ? this._s.add(c) : this._s.delete(c); return f; }, contains(c) { return this._s.has(c); } },
    setAttribute(k, v) { el.attrs[k] = String(v); if (k === 'id') { el.id = String(v); registry[el.id] = el; } },
    getAttribute(k) { return el.attrs[k]; },
    appendChild(c) { el.children.push(c); if (c && c.id) registry[c.id] = c; return c; },
    remove() {}, click() { if (typeof el.onclick === 'function') el.onclick(); }, focus() {}, blur() {},
    querySelector() { return null; }, querySelectorAll() { return []; }
  };
  // like the DOM: assigning innerHTML replaces the children, so handlers attached to them are gone
  const detach = (node) => { node.onclick = null; node.onchange = null; (node.children || []).forEach(detach); node.children = []; };
  return new Proxy(el, { set(t, k, v) { if (k === 'innerHTML' && t.children && t.children.length) { t.children.forEach(detach); t.children = []; } t[k] = v; if (k === 'id' && v) registry[v] = t; return true; } });
}

export class World {
  constructor(opts = {}) {
    this.store = new FakeStore();
    this.storage = new Map();
    this.reloads = 0;
    this.fsWrites = [];
    this.shares = [];
    this.syncRequests = [];
    this.config = opts.config || { readRetryMs: 400, quiesceMs: 400, exportWaitMs: 300, embedTimeoutMs: 300 };
    this.now = opts.now || null;
  }
  evict() { this.storage.clear(); }
  // the app dies: the page is gone and so is the plugin's queue (a call hung inside it never answers)
  kill() { this.store.queue = Promise.resolve(); this.store.holdAcks = {}; this.store.killAt = null; }
  raw() { return this.storage.has('train_state') ? this.storage.get('train_state') : null; }
  // Launch the page. Resolves once the (patched) DOMContentLoaded handler has run, i.e. after hydration,
  // unless `noWait` (for tests that inspect the loading view while a read hangs).
  async boot(opts = {}) {
    const world = this; const els = {}; const listeners = {}; const winListeners = {}; const created = [];
    const storage = this.storage;
    const on = (reg) => (type, fn) => { (reg[type] = reg[type] || []).push(fn); };
    const fire = (reg, type, ev) => (reg[type] || []).slice().forEach((fn) => fn(ev || { type }));
    const documentStub = {
      getElementById(id) { if (!els[id]) els[id] = makeEl(els, 'div'); return els[id]; },
      querySelectorAll() { return []; }, addEventListener: on(listeners),
      removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
      createElement(tag) { const el = makeEl(els, tag); created.push(el); return el; },
      body: { addEventListener() {}, innerHTML: '', appendChild(c) { if (c && c.id) els[c.id] = c; return c; } },
      documentElement: { appendChild(c) { if (c && c.id) els[c.id] = c; return c; } },
      visibilityState: 'visible', readyState: 'loading'
    };
    const audioContexts = [];
    class SpyAudioContext { constructor() { audioContexts.push(this); this.state = 'running'; } resume() {} createOscillator() { return { connect() {}, start() {}, stop() {}, frequency: {} }; } createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; } }
    class FakeFile { constructor(parts, name, o) { this.parts = parts; this.name = name; this.type = (o && o.type) || ''; this.text = parts.join(''); } }
    class FakeFileReader { readAsText(f) { Promise.resolve().then(() => this.onload({ target: { result: f.text } })); } }
    const plugins = {
      TrainStore: this.store.plugin(),
      Filesystem: { writeFile: async (a) => { world.fsWrites.push(a); return { uri: 'file:///cache/' + a.path }; }, getUri: async (a) => ({ uri: 'file:///lib/' + a.path }) },
      Share: { share: async (a) => { world.shares.push(a); if (world.shareError) throw world.shareError; return { activityType: 'test' }; } },
      Haptics: { impact: async (a) => { world.haptics.push({ impact: a.style }); }, notification: async (a) => { world.haptics.push({ notification: a.type }); }, vibrate: async (a) => { world.haptics.push({ vibrate: a.duration }); } }
    };
    this.haptics = this.haptics || [];
    const ctx = {
      localStorage: { getItem: (k) => storage.has(k) ? storage.get(k) : null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k), clear: () => storage.clear() },
      document: documentStub, navigator: { vibrate() { world.vibrates = (world.vibrates || 0) + 1; return true; } }, setTimeout, clearTimeout, setInterval, clearInterval,
      addEventListener: on(winListeners), removeEventListener(type, fn) { winListeners[type] = (winListeners[type] || []).filter((f) => f !== fn); },
      dispatchEvent(ev) { fire(winListeners, ev.type, ev); return true; },
      AudioContext: SpyAudioContext, webkitAudioContext: SpyAudioContext,
      // a per-context console (bridge.js wraps it for its log ring); warnings and errors reach the test output, chatter does not
      console: { log: () => {}, info: () => {}, debug: () => {}, warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) },
      Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Promise, Uint8Array, Set, Map, RegExp, Symbol, Proxy, Reflect,
      crypto: webcrypto, TextEncoder, AbortController,
      alert(m) { world.alerts = world.alerts || []; world.alerts.push(m); }, prompt() { return null; },
      fetch(url, init) {
        const u = String(url);
        if (/^fixtures\//.test(u)) { const data = readFileSync(join(nativeDir, 'test', u), 'utf8'); return Promise.resolve({ ok: true, json: async () => JSON.parse(data), text: async () => data }); }
        if (/\/embed\.html$/.test(u)) { world.embedProbes = (world.embedProbes || 0) + 1; const status = world.embedWrapperStatus || 200; return Promise.resolve({ ok: status === 200, status }); }
        const req = { url: u, init, body: init && init.body ? JSON.parse(init.body) : null, headers: (init && init.headers) || {}, at: Date.now() };
        world.syncRequests.push(req);
        if (!world.syncResponder) return Promise.reject(new Error('no network in the shell tests'));
        // the responder answers { status, body } (body an object or a string) after an optional delay; it sees the in-flight count
        world.syncInflight = (world.syncInflight || 0) + 1; world.syncMaxInflight = Math.max(world.syncMaxInflight || 0, world.syncInflight);
        return Promise.resolve(world.syncResponder(req)).then((r) => {
          world.syncInflight--;
          if (r instanceof Error) throw r;
          const status = r.status || 200; const bodyText = typeof r.body === 'string' ? r.body : JSON.stringify(r.body == null ? {} : r.body);
          return { ok: status >= 200 && status < 300, status, text: async () => bodyText, json: async () => JSON.parse(bodyText) };
        }, (e) => { world.syncInflight--; throw e; });
      },
      location: { origin: 'capacitor://localhost', href: 'capacitor://localhost/index.html', reload() { world.reloads++; } },
      URL: class extends URL { static createObjectURL() { return 'blob:x'; } static revokeObjectURL() {} },
      Blob: class { constructor(parts, o) { this.parts = parts; this.type = (o && o.type) || ''; } }, FileReader: FakeFileReader, File: FakeFile,
      isSecureContext: true,
      Capacitor: { Plugins: plugins, PluginHeaders: Object.keys(plugins).map((name) => ({ name })) },
      __storeConfig: this.config
    };
    ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
    vm.createContext(ctx);
    const dir = patched();
    vm.runInContext(readFileSync(join(dir, 'data.js'), 'utf8'), ctx);
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    const m = /<script>\n([\s\S]*)\n<\/script>/.exec(html);
    assert.ok(m, 'inline app script found in the patched copy');
    assert.ok(/<script src="bridge\.js"><\/script>/.test(html), 'the patched copy loads bridge.js');
    vm.runInContext(m[1] + '\n;globalThis.__AS = () => AS; globalThis.__setAS = (v) => { AS = v; }; globalThis.__PTS = () => PTS;', ctx);
    vm.runInContext(readFileSync(join(nativeDir, 'www', 'bridge.js'), 'utf8'), ctx);
    documentStub.readyState = 'interactive';
    const page = { ctx, els, listeners, world: this, store: this.store, created,
      get home() { return els['home-content'] ? els['home-content'].innerHTML : ''; },
      // the stub does not splice appended children into innerHTML, so the store card is reported alongside
      settings() { ctx.renderSettings(); return (els['settings-content'] ? els['settings-content'].innerHTML : '') + (els['store-card'] ? '\n' + els['store-card'].innerHTML : ''); },
      modalTitle() { return els['modal-title'] ? els['modal-title'].textContent : ''; },
      modalBody() { return els['modal-body'] ? els['modal-body'].textContent : ''; },
      pressModal(text) { const el = els['mb-' + text.replace(/\s/g, '')]; assert.ok(el && el.onclick, `modal button "${text}"`); return el.onclick(); },
      banner() { const b = els['store-banner']; return (b && !b.hidden) ? (els['store-banner-text'] ? els['store-banner-text'].textContent : b.innerHTML) : null; },
      loading() { const v = els['store-loading']; return (v && !v.hidden && v.style.display !== 'none') ? (els['store-loading-text'] ? els['store-loading-text'].textContent : 'loading') : null; },
      loadingDisplay() { const v = els['store-loading']; return v ? v.style.display : undefined; },
      state() { return ctx.getState(); },
      bridge: ctx.__store,
      wake: ctx.__wake,
      audioContexts,
      // the phone goes to the background and comes back: the document's visibility flips (the app's and the
      // bridge's handlers run in registration order) and native releases the idle timer in between
      async hide() { documentStub.visibilityState = 'hidden'; fire(listeners, 'visibilitychange'); await sleep(5); world.store.background(); await sleep(5); },
      async show() { documentStub.visibilityState = 'visible'; fire(listeners, 'visibilitychange'); await sleep(20); },
      hideOnly() { documentStub.visibilityState = 'hidden'; fire(listeners, 'visibilitychange'); },
      showOnly() { documentStub.visibilityState = 'visible'; fire(listeners, 'visibilitychange'); },
      postMessage(data, origin = 'https://hyndesyte.github.io') { fire(winListeners, 'message', { type: 'message', data, origin }); },
      // the modal's HTML (the reference modal renders its embed iframe into modal-body)
      modalHtml() { return els['modal-body'] ? els['modal-body'].innerHTML : ''; },
      // wait until the save chain has drained (every queued save settled)
      async settle(ms = 2000) { const t0 = Date.now(); while (ctx.__store.pendingSaves > 0 && Date.now() - t0 < ms) await sleep(5); return ctx.__store.pendingSaves === 0; }
    };
    const handlers = listeners.DOMContentLoaded || [];
    assert.ok(handlers.length, 'DOMContentLoaded handler registered');
    page.ready = Promise.resolve().then(async () => { for (const h of handlers) await h(); });
    if (!opts.noWait) await page.ready;
    return page;
  }
}

// a state in the live app's shape (the hand-off tests use the same seed)
export const NOW = Date.UTC(2026, 9, 19, 0, 30, 0);
export function entry(n, extra) {
  return Object.assign({ sessionId: `sid-${String(n).padStart(4, '0')}`, sessionSequence: n, date: '2026-10-1' + (n % 9), startedAt: NOW - 3600000 * n, completedAt: NOW - 3600000 * n + 600000,
    sessionType: 'PT', sessionStatus: 'completed', duration: 6, coreComplete: true, mode: 'recovery', ptList: true, ptItems: [], performed: [],
    notionSync: { status: 'synced', syncedAt: '2026-10-18T22:00:00.000Z', notionPageId: 'p', error: null } }, extra || {});
}
export function seedState(extra) {
  return Object.assign({ schemaVersion: 9, progressionEngineVersion: 3, rotationIndex: 0, nextSessionOverride: null, nextSessionSequence: 4,
    pendingDeletes: [], activeSession: null, legacy: { promotions: {}, exerciseVariations: {}, promotionLog: [] }, anchorProgress: {},
    recovery: { on: true, cardioClear: false, since: '2026-10-15T12:00:00.000Z', offAt: null }, armCheck: null,
    log: [entry(1), entry(2), entry(3)] }, extra || {});
}
// bytes as the shell would have committed them at `rev` in `generation` (stamped)
export function committedBytes(state, rev, base) { return JSON.stringify(Object.assign({}, state, { _base: base == null ? rev - 1 : base, _rev: rev })); }
