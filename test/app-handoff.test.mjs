// Hand-off (plan v4 section 5, shipped before the native cutover): the PWA's hand-off switch,
// its writer.json backstop, the X-Train-Client header and the Settings count-and-digest line.
// The boot handler is captured and run by hand so the backstop's first-statement reads are
// exercised; fetch is a spy that answers writer.json per scenario and records sync posts.
process.env.TZ = 'America/New_York';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const WRITER_URL = 'https://hyndesyte.github.io/train/writer.json';
const SYNC_URL = 'https://hyndesyte-train-sync.netlify.app/.netlify/functions/sync-training-session';
const NOW = Date.UTC(2026, 9, 19, 0, 30, 0);   // 2026-10-18 20:30 EDT

function makeEl(){
  return { innerHTML:'', textContent:'', value:'', checked:false, style:{}, onclick:null, clicks:0, click(){ this.clicks++; },
    classList:{ _s:new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, toggle(c,f){ if(f===undefined) f=!this._s.has(c); f?this._s.add(c):this._s.delete(c); return f; } } };
}
function makeClock(startMs){
  const clock = { now: startMs };
  class FakeDate extends Date {
    constructor(...args){ if(args.length === 0) super(clock.now); else super(...args); }
    static now(){ return clock.now; }
  }
  clock.Date = FakeDate;
  return clock;
}

// writer: 'native' | 'pwa' | 'malformed' | '404' | 'offline' | 'hang' | undefined (no answer needed)
function boot(opts = {}){
  const els = {}; const listeners = {}; const calls = [];
  const storage = opts.storage || new Map();
  if(opts.seed) storage.set('train_state', JSON.stringify(opts.seed));
  if(opts.key !== undefined) storage.set('train_handoff', opts.key);
  const clock = makeClock(NOW);
  const documentStub = {
    getElementById(id){ if(!els[id]) els[id] = makeEl(); return els[id]; },
    querySelectorAll(){ return []; }, addEventListener(type, fn){ listeners[type] = fn; },
    createElement(){ return makeEl(); }, body:{ addEventListener(){}, innerHTML:'' }, visibilityState:'visible'
  };
  class FakeFile { constructor(parts, name, o){ this.parts = parts; this.name = name; this.type = (o && o.type) || ''; } }
  class FakeFileReader { readAsText(f){ const text = f.text; Promise.resolve().then(()=> this.onload({ target:{ result:text } })); } }
  const fastTimers = !!opts.fastTimers;
  const ctx = {
    localStorage:{ getItem:k=>storage.has(k)?storage.get(k):null, setItem:(k,v)=>storage.set(k,String(v)), removeItem:k=>storage.delete(k) },
    document: documentStub, navigator:{}, console, clearTimeout,
    setTimeout: fastTimers ? (fn)=>setTimeout(fn, 0) : setTimeout,
    Date: clock.Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Promise, Uint8Array,
    crypto: webcrypto, TextEncoder, AbortController,
    alert(){}, prompt(){ return null; },
    fetch(url, init){
      calls.push({ url:String(url), init });
      if(String(url).startsWith(WRITER_URL)){
        const w = opts.writer;
        if(w === 'offline') return Promise.reject(new Error('offline'));
        if(w === 'hang') return new Promise(()=>{});
        if(w === '404') return Promise.resolve({ ok:false, status:404, json: async()=>({}) });
        if(w === 'malformed') return Promise.resolve({ ok:true, status:200, json: async()=>{ throw new Error('bad json'); } });
        if(w === 'native' || w === 'pwa') return Promise.resolve({ ok:true, status:200, json: async()=>({ writer: w }) });
        return Promise.reject(new Error('unexpected writer.json fetch'));
      }
      if(String(url) === SYNC_URL) return Promise.resolve({ ok:true, status:200, json: async()=>({ ok:true, notionPageId:'page-1', action:'created' }) });
      return Promise.reject(new Error('unexpected fetch ' + url));
    },
    URL:{ createObjectURL(){ return 'blob:x'; }, revokeObjectURL(){} },
    Blob: class { constructor(parts, o){ this.parts = parts; this.type = (o && o.type) || ''; } }, FileReader: FakeFileReader, File: FakeFile,
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(root,'data.js'),'utf8'), ctx);
  const html = readFileSync(join(root,'index.html'),'utf8');
  const m = /<script>\n([\s\S]*)\n<\/script>/.exec(html);
  assert.ok(m, 'inline app script found');
  vm.runInContext(m[1] + '\n;globalThis.__AS = () => AS; globalThis.__setAS = (v) => { AS = v; }; globalThis.__PTS = () => PTS; globalThis.__setPTS = (v) => { PTS = v; }; globalThis.__draining = (v) => { syncDraining = v; };', ctx);
  if(opts.shell) ctx.handoffSupported = () => false;   // what bridge.js does before DOMContentLoaded
  const writerFetches = () => calls.filter(c => c.url.startsWith(WRITER_URL)).length;
  const syncPosts = () => calls.filter(c => c.url === SYNC_URL);
  const home = () => els['home-content'] ? els['home-content'].innerHTML : '';
  const settings = () => { ctx.renderSettings(); return els['settings-content'].innerHTML; };
  const runBoot = () => listeners.DOMContentLoaded();
  const pressModal = (text) => { const el = els['mb-' + text.replace(/\s/g,'')]; assert.ok(el && el.onclick, `modal button "${text}" present`); return el.onclick(); };
  return { ctx, els, storage, calls, writerFetches, syncPosts, home, settings, runBoot, pressModal, listeners };
}

const SID = (n) => `sid-${String(n).padStart(4,'0')}`;
function entry(n, extra){
  return Object.assign({ sessionId: SID(n), sessionSequence: n, date:'2026-10-1' + (n % 9), startedAt: NOW - 3600000 * n, completedAt: NOW - 3600000 * n + 600000,
    sessionType:'PT', sessionStatus:'completed', duration: 6, coreComplete:true, mode:'recovery', ptList:true, ptItems:[], performed:[],
    notionSync:{ status:'synced', syncedAt:'2026-10-18T22:00:00.000Z', notionPageId:'p', error:null } }, extra || {});
}
function seed(extra){
  return Object.assign({ schemaVersion:8, progressionEngineVersion:3, rotationIndex:0, nextSessionOverride:null, nextSessionSequence:4,
    pendingDeletes:[], activeSession:null, legacy:{ promotions:{}, exerciseVariations:{}, promotionLog:[] }, anchorProgress:{},
    recovery:{ on:true, cardioClear:false, since:'2026-10-15T12:00:00.000Z', offAt:null }, armCheck:null,
    log:[ entry(1), entry(2), entry(3) ] }, extra || {});
}

// ---- the switch ---------------------------------------------------------------------------

test('switch on: Home shows the handed-off card and no start, PT or resume path; boot skips the sync', async () => {
  const b = boot({ seed: seed({ log:[ entry(1), entry(2, { notionSync:{ status:'pending' } }) ] }), key:'on' });
  await b.runBoot();
  assert.equal(b.writerFetches(), 0, 'no writer.json fetch with an explicit flag');
  assert.equal(b.syncPosts().length, 0, 'boot sync skipped');
  assert.match(b.home(), /Handed off to the Train app/);
  assert.doesNotMatch(b.home(), /startSession\(|startPtSession\(|resumeSession\(/);
});

test('switch on: the three sync functions are no-ops and mark nothing', async () => {
  const b = boot({ seed: seed({ log:[ entry(1, { notionSync:{ status:'pending' } }) ], pendingDeletes:['sid-9999'] }), key:'on' });
  await b.ctx.pushUnsynced();
  await b.ctx.syncEntry(SID(1));
  await assert.rejects(() => b.ctx.postSync({ op:'delete', sessionId:'x' }), /handed off/);
  assert.equal(b.syncPosts().length, 0);
  const s = b.ctx.getState();
  assert.equal(s.log[0].notionSync.status, 'pending', 'syncEntry touched nothing');
  assert.deepEqual(s.pendingDeletes, ['sid-9999'], 'tombstone still queued');
});

test('switch on: Settings hides Erase and Retry sync, keeps Export and Import; History hides Delete', () => {
  const b = boot({ seed: seed(), key:'on' });
  const html = b.settings();
  assert.doesNotMatch(html, /confirmErase\(\)/);
  assert.doesNotMatch(html, /Retry sync/);
  assert.match(html, /exportData\(\)/);
  assert.match(html, /importData\(event\)/);
  assert.match(html, /confirmHandoffUndo\(\)/);
  b.ctx.renderHistory();
  assert.doesNotMatch(b.els['history-content'].innerHTML, /confirmDeleteSession\(/);
  // Export still produces the file; Import still replaces the state and leaves the flag alone.
  b.ctx.navigator.share = () => Promise.resolve(); b.ctx.navigator.canShare = () => true;
  b.ctx.exportData();
  const backup = JSON.stringify(seed({ log:[ entry(7) ], nextSessionSequence: 8 }));
  b.ctx.importData({ target:{ files:[{ text: backup }] } });
  return new Promise(resolve => setTimeout(resolve, 0)).then(() => {
    b.pressModal('Import');
    assert.equal(b.ctx.getState().log.length, 1, 'import replaced the log');
    assert.equal(b.storage.get('train_handoff'), 'on', 'import left the flag alone');
    assert.match(b.home(), /Handed off/, 'Home still handed off after import');
  });
});

test('switch refuses with a parked session, with pending items, and while a drain is in flight', () => {
  const parked = boot({ seed: seed({ activeSession:{ type:'RP', parkedAt: NOW - 1000, parkExpiresAt: NOW + 86400000, records:{} } }) });
  parked.ctx.confirmHandoff();
  assert.equal(parked.els['modal-title'].textContent, 'Finish first');
  assert.match(parked.els['modal-body'].textContent, /parked session/);
  assert.equal(parked.storage.get('train_handoff'), undefined);

  const pending = boot({ seed: seed({ log:[ entry(1), entry(2, { notionSync:{ status:'failed' } }) ], pendingDeletes:['sid-0009'] }) });
  pending.ctx.confirmHandoff();
  assert.equal(pending.els['modal-title'].textContent, 'Finish first');
  assert.match(pending.els['modal-body'].textContent, /2 items still to sync/);

  const draining = boot({ seed: seed() });
  draining.ctx.__draining(true);
  draining.ctx.confirmHandoff();
  assert.match(draining.els['modal-body'].textContent, /sync in progress/);

  const pt = boot({ seed: seed() });
  pt.ctx.__setPTS({ startedAt: NOW, status:{}, run:null, note:'' });
  pt.ctx.confirmHandoff();
  assert.match(pt.els['modal-body'].textContent, /PT’s list in progress/);
});

test('switch on through the confirm, then undo re-posts what is pending', async () => {
  const b = boot({ seed: seed() });
  b.ctx.confirmHandoff();
  assert.equal(b.els['modal-title'].textContent, 'Hand off to the Train app?');
  b.pressModal('Hand off');
  assert.equal(b.storage.get('train_handoff'), 'on');
  assert.ok(b.ctx.handoffActive());
  b.ctx.renderHome();
  assert.match(b.home(), /Handed off/);
  // undo: a session logged elsewhere is now pending here; taking the hand-off back sends it
  const s = b.ctx.getState(); s.log.push(entry(4, { notionSync:{ status:'pending' } })); b.ctx.saveState(s);
  b.ctx.confirmHandoffUndo();
  b.pressModal('Take it back');
  assert.equal(b.storage.get('train_handoff'), 'off');
  await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
  const posts = b.syncPosts();
  assert.equal(posts.length, 1, 'the pending entry was posted on undo');
  assert.equal(JSON.parse(posts[0].init.body).sessionId, SID(4));
  assert.equal(posts[0].init.headers['X-Train-Client'], 'pwa');
  assert.equal(b.ctx.getState().log[3].notionSync.status, 'synced');
});

test('expireParkIfDue does nothing while handed off', () => {
  const b = boot({ seed: seed({ activeSession:{ type:'RP', parkedAt: NOW - 3 * 86400000, parkExpiresAt: NOW - 86400000, records:{}, cursor:0 } }), key:'on' });
  assert.equal(b.ctx.expireParkIfDue(), false);
  assert.ok(b.ctx.getState().activeSession, 'the parked session is untouched');
});

// ---- the remote backstop ----------------------------------------------------------------

test('no state, no flag: the remote flag decides; native reads read-only, pwa reads writable', async () => {
  const n = boot({ writer:'native' });
  await n.runBoot();
  assert.equal(n.writerFetches(), 1);
  assert.equal(n.storage.get('train_handoff'), 'on');
  assert.match(n.home(), /Handed off to the Train app/);
  assert.doesNotMatch(n.home(), /startSession\(/);
  const init = n.calls.find(c => c.url.startsWith(WRITER_URL)).init;
  assert.equal(init.cache, 'no-store');
  assert.match(n.calls.find(c => c.url.startsWith(WRITER_URL)).url, /writer\.json\?t=\d+/);

  const p = boot({ writer:'pwa' });
  await p.runBoot();
  assert.equal(p.writerFetches(), 1);
  assert.equal(p.storage.get('train_handoff'), 'off');
  assert.match(p.home(), /startSession\(/, 'writable Home');
  assert.ok(p.storage.has('train_state'), 'default state written after the decision');
});

test('no state, no flag: offline, 404 and a malformed body leave the copy read-only with the banner', async () => {
  for(const writer of ['offline', '404', 'malformed']){
    const b = boot({ writer });
    await b.runBoot();
    assert.equal(b.storage.get('train_handoff'), 'unknown', writer);
    assert.match(b.home(), /Can&rsquo;t tell which app is in charge/, writer);
    assert.match(b.home(), /retryHandoffBackstop\(\)/, writer);
    assert.doesNotMatch(b.home(), /startSession\(/, writer);
    assert.ok(b.ctx.handoffActive());
    assert.equal(b.syncPosts().length, 0);
    assert.match(b.settings(), /Retry connection/);
  }
});

test('no state, no flag: a flag that never answers times out into unknown; Home held meanwhile', async () => {
  const b = boot({ writer:'hang', fastTimers:true });
  const boot_ = b.runBoot();
  assert.match(b.home(), /Checking which app is in charge/);
  assert.ok(b.ctx.handoffActive(), 'read-only while the fetch is pending');
  await boot_;
  assert.equal(b.storage.get('train_handoff'), 'unknown');
  assert.match(b.home(), /Can&rsquo;t tell which app is in charge/);
});

test('unknown at boot 1 (default state written), then boot 2 re-reads the flag: native stays read-only, pwa turns writable', async () => {
  const storage = new Map();
  const first = boot({ writer:'offline', storage });
  await first.runBoot();
  assert.equal(storage.get('train_handoff'), 'unknown');
  assert.ok(storage.has('train_state'), 'a default state was written during the unknown boot');

  const second = boot({ writer:'native', storage });
  await second.runBoot();
  assert.equal(second.writerFetches(), 1, 'unknown re-reads even with state present');
  assert.equal(storage.get('train_handoff'), 'on');
  assert.doesNotMatch(second.home(), /startSession\(/);

  const storage2 = new Map();
  const a = boot({ writer:'404', storage: storage2 }); await a.runBoot();
  assert.equal(storage2.get('train_handoff'), 'unknown');
  const c = boot({ writer:'pwa', storage: storage2 }); await c.runBoot();
  assert.equal(storage2.get('train_handoff'), 'off');
  assert.match(c.home(), /startSession\(/);
});

test('the Retry button re-runs the backstop in place', async () => {
  const b = boot({ writer:'offline' });
  await b.runBoot();
  assert.equal(b.storage.get('train_handoff'), 'unknown');
  b.calls.length = 0;
  // the network comes back and the flag says pwa
  const orig = b.ctx.fetch;
  b.ctx.fetch = (url, init) => { if(String(url).startsWith(WRITER_URL)){ b.calls.push({ url:String(url), init }); return Promise.resolve({ ok:true, status:200, json: async()=>({ writer:'pwa' }) }); } return orig(url, init); };
  await b.ctx.retryHandoffBackstop();
  assert.equal(b.storage.get('train_handoff'), 'off');
  assert.match(b.home(), /startSession\(/);
});

test('state present and no flag, or an explicit off: no fetch, writable', async () => {
  const existing = boot({ seed: seed(), writer:'native' });   // a native flag would be wrong to obey here
  await existing.runBoot();
  assert.equal(existing.writerFetches(), 0);
  assert.equal(existing.storage.get('train_handoff'), undefined, 'no flag written for an existing copy');
  assert.match(existing.home(), /startSession\(/);

  const off = boot({ key:'off', writer:'native' });
  await off.runBoot();
  assert.equal(off.writerFetches(), 0);
  assert.equal(off.storage.get('train_handoff'), 'off');
  assert.match(off.home(), /startSession\(/);
});

test('the shell (handoffSupported false): no fetch, no hold, no row, writable, even with no state and a native flag', async () => {
  const b = boot({ writer:'native', shell:true });
  await b.runBoot();
  assert.equal(b.writerFetches(), 0);
  assert.equal(b.storage.get('train_handoff'), undefined);
  assert.match(b.home(), /startSession\(/);
  assert.doesNotMatch(b.settings(), /confirmHandoff\(\)|Hand-off|Hand off to/);
  // and an 'on' left behind in storage changes nothing in the shell either
  const c = boot({ seed: seed(), key:'on', shell:true });
  await c.runBoot();
  assert.equal(c.ctx.handoffActive(), false);
  assert.match(c.home(), /startSession\(/);
});

// ---- the header and the digest --------------------------------------------------------

test('every sync post carries X-Train-Client: pwa', async () => {
  const b = boot({ seed: seed({ log:[ entry(1, { notionSync:{ status:'pending' } }) ], pendingDeletes:['sid-0042'] }) });
  await b.ctx.pushUnsynced();
  const posts = b.syncPosts();
  assert.equal(posts.length, 2, 'one tombstone, one upsert');
  for(const p of posts) assert.equal(p.init.headers['X-Train-Client'], 'pwa');
  assert.equal(posts[0].init.headers['Content-Type'], 'application/json');
});

test('digest fixture: first 8 hex of SHA-256 over sorted ids joined by LF, no trailing newline', async () => {
  const b = boot({ seed: seed({ log:[ entry(1, { sessionId:'s-b' }), entry(2, { sessionId:'s-a' }), entry(3, { sessionId:'s-c' }) ] }) });
  const expected = createHash('sha256').update('s-a\ns-b\ns-c').digest('hex').slice(0, 8);
  assert.equal(expected, '3175a2eb', 'the fixture the mirror script must reproduce');
  assert.equal(await b.ctx.sessionDigest(b.ctx.getState()), '3175a2eb');
  b.settings();
  await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
  assert.equal(b.els['session-digest'].textContent, '3 sessions · digest 3175a2eb');
  // an empty log digests the empty string; migrate() gives every entry an id, so after it the
  // count equals the log length
  const e = boot({ seed: seed({ log:[] }) });
  assert.equal(await e.ctx.sessionDigest(e.ctx.getState()), 'e3b0c442');
  const mixed = boot({ seed: seed({ log:[ entry(1, { sessionId:'s-a' }), entry(2, { sessionId: undefined }) ] }) });
  assert.equal(mixed.ctx.sessionIdsOf(mixed.ctx.getState()).length, 2);
});

test('the Settings row offers the hand-off only when writable', () => {
  const w = boot({ seed: seed() });
  assert.match(w.settings(), /confirmHandoff\(\)/);
  assert.doesNotMatch(w.settings(), /confirmHandoffUndo\(\)/);
  const on = boot({ seed: seed(), key:'on' });
  assert.match(on.settings(), /confirmHandoffUndo\(\)/);
  assert.doesNotMatch(on.settings(), /onclick="confirmHandoff\(\)"/);
  assert.match(on.settings(), /All sessions synced &middot; paused: this copy is handed off/, 'the sync status keeps its count and names the state');
  const onPending = boot({ seed: seed({ log:[ entry(1), entry(2, { notionSync:{ status:'pending' } }) ] }), key:'on' });
  assert.match(onPending.settings(), /1 pending &middot; paused: this copy is handed off/, 'the pending count stays visible for the rollback check');
  onPending.ctx.refreshSyncIndicator();
  assert.match(onPending.els['sync-indicator'].innerHTML, /1 pending &middot; paused/, 'Home indicator says paused, not syncing');
  assert.doesNotMatch(onPending.els['sync-indicator'].innerHTML, /syncing/);
  const unknown = boot({ seed: seed(), key:'unknown' });
  assert.match(unknown.settings(), /paused: which app is in charge is unknown/);
});

test('a stale tab cannot start, resume, start PT or delete while handed off (direct guards)', () => {
  const b = boot({ seed: seed({ activeSession:{ type:'RP', parkedAt: NOW - 1000, parkExpiresAt: NOW + 86400000, records:{}, cursor:0 } }), key:'on' });
  // Home rendered with a parked session and the flag on: no Resume path
  b.ctx.renderHome();
  assert.match(b.home(), /Handed off/);
  assert.doesNotMatch(b.home(), /resumeSession\(|Resume/);
  b.ctx.resumeSession();
  assert.equal(b.ctx.__AS(), null, 'resume refused');
  const logBefore = b.ctx.getState().log.length;
  b.ctx.startSession('RP');
  assert.equal(b.ctx.__AS(), null, 'start refused');
  b.ctx.startPtSession();
  assert.equal(b.ctx.__PTS(), null, 'PT start refused');
  b.ctx.deleteLogEntry(0);
  assert.equal(b.ctx.getState().log.length, logBefore, 'delete refused');
  assert.deepEqual(b.ctx.getState().pendingDeletes, [], 'no tombstone queued');
  assert.ok(b.ctx.getState().activeSession, 'the parked session is still there (nothing wrote)');
});

test('the in-progress session blocks the switch with its own wording', () => {
  const b = boot({ seed: seed({ activeSession:{ type:'RP', parkedAt: null, records:{}, cursor:0 } }) });
  b.ctx.confirmHandoff();
  assert.equal(b.els['modal-title'].textContent, 'Finish first');
  assert.match(b.els['modal-body'].textContent, /the session in progress/);
});

test('Retry runs once at a time and a slow earlier run cannot overwrite a later answer', async () => {
  const b = boot({ writer:'offline' });
  await b.runBoot();
  assert.equal(b.storage.get('train_handoff'), 'unknown');
  // first retry: a flag read that never answers; second tap while it is pending is a no-op
  let resolveSlow;
  const orig = b.ctx.fetch;
  b.ctx.fetch = (url, init) => { if(String(url).startsWith(WRITER_URL)){ b.calls.push({ url:String(url), init }); return new Promise(r => { resolveSlow = r; }); } return orig(url, init); };
  const reads0 = b.writerFetches();
  const first = b.ctx.retryHandoffBackstop();
  assert.ok(b.ctx.handoffActive(), 'read-only while the retry is pending');
  assert.match(b.home(), /Checking which app is in charge/, 'Home shows the hold at once');
  await b.ctx.retryHandoffBackstop();   // second tap: returns without a second read
  assert.equal(b.writerFetches(), reads0 + 1, 'one read in flight, not two');
  resolveSlow({ ok:true, status:200, json: async()=>({ writer:'pwa' }) });
  await first;
  assert.equal(b.storage.get('train_handoff'), 'off');
  assert.match(b.home(), /startSession\(/);
});

test('the flag value is read trimmed and case-folded, like the function reads it', async () => {
  const b = boot();
  b.ctx.fetch = (url) => Promise.resolve({ ok:true, status:200, json: async()=>({ writer:' Native ' }) });
  await b.runBoot();
  assert.equal(b.storage.get('train_handoff'), 'on');
  const c = boot();
  c.ctx.fetch = (url) => Promise.resolve({ ok:true, status:200, json: async()=>({ writer:'PWA', extra:true }) });
  await c.runBoot();
  assert.equal(c.storage.get('train_handoff'), 'off');
  const d = boot();
  d.ctx.fetch = (url) => Promise.resolve({ ok:true, status:200, json: async()=>({ writer:'both' }) });
  await d.runBoot();
  assert.equal(d.storage.get('train_handoff'), 'unknown');
});
