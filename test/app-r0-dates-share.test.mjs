// R0 (2026-10-18): entry dates follow the user's local day, and Export goes through the share
// sheet when the browser can share files. The clock is pinned to an Eastern evening, where the
// UTC date has already rolled over: 8:30 PM EDT (Oct 18 -> 2026-10-19T00:30Z) and 7:30 PM EST
// (Nov 5 -> 2026-11-06T00:30Z). This file forces TZ=America/New_York for its own process only
// (node --test runs each file in its own process), so the suite stays green under any host TZ.
process.env.TZ = 'America/New_York';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const EDT_EVENING = Date.UTC(2026, 9, 19, 0, 30, 0);   // 2026-10-18 20:30 EDT
const EST_EVENING = Date.UTC(2026, 10, 6, 0, 30, 0);   // 2026-11-05 19:30 EST

function makeEl(){
  return { innerHTML:'', textContent:'', value:'', checked:false, style:{}, onclick:null, clicks:0, click(){ this.clicks++; },
    classList:{ _s:new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, toggle(c,f){ if(f===undefined) f=!this._s.has(c); f?this._s.add(c):this._s.delete(c); return f; } } };
}

// A Date whose "now" is pinned and movable: new Date() and Date.now() read clock.now; explicit
// arguments behave normally, so stored timestamps still parse.
function makeClock(startMs){
  const clock = { now: startMs };
  class FakeDate extends Date {
    constructor(...args){ if(args.length === 0) super(clock.now); else super(...args); }
    static now(){ return clock.now; }
  }
  clock.Date = FakeDate;
  return clock;
}

function boot(opts = {}){
  const els = {}; const created = [];
  const storage = new Map(opts.seed ? [['train_state', JSON.stringify(opts.seed)]] : []);
  const clock = makeClock(opts.now || EDT_EVENING);
  const shares = []; const canShareCalls = [];
  const navigator = opts.navigator ? opts.navigator(shares, canShareCalls) : {};
  const documentStub = {
    getElementById(id){ if(!els[id]) els[id] = makeEl(); return els[id]; },
    querySelectorAll(){ return []; }, addEventListener(){},
    createElement(){ const el = makeEl(); created.push(el); return el; },
    body:{ addEventListener(){}, innerHTML:'' }, visibilityState:'visible'
  };
  const urls = { created:0, revoked:0 };
  class FakeFile { constructor(parts, name, o){ this.parts = parts; this.name = name; this.type = (o && o.type) || ''; } }
  const ctx = {
    localStorage:{ getItem:k=>storage.has(k)?storage.get(k):null, setItem:(k,v)=>storage.set(k,String(v)), removeItem:k=>storage.delete(k) },
    document: documentStub, navigator, console, setTimeout, clearTimeout,
    Date: clock.Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Promise, crypto: undefined,
    alert(){}, prompt(){ return null; },
    fetch(){ return Promise.reject(new Error('no network in tests')); },
    URL:{ createObjectURL(){ urls.created++; return 'blob:x'; }, revokeObjectURL(){ urls.revoked++; } },
    Blob: class { constructor(parts, o){ this.parts = parts; this.type = (o && o.type) || ''; } }, FileReader: class {},
    File: opts.noFile ? undefined : FakeFile,
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(root,'data.js'),'utf8'), ctx);
  const html = readFileSync(join(root,'index.html'),'utf8');
  const m = /<script>\n([\s\S]*)\n<\/script>/.exec(html);
  assert.ok(m, 'inline app script found');
  vm.runInContext(m[1] + '\n;globalThis.__AS = () => AS; globalThis.__setAS = (v) => { AS = v; }; globalThis.__PTS = () => PTS;', ctx);
  return { ctx, els, storage, clock, created, urls, shares, canShareCalls };
}
const AS_ = (c) => c.__AS();

// Drive helpers (same shape as app-elastic.test.mjs) --------------------------------
function skipForm(ctx){
  let guard = 0;
  while(guard++ < 20){
    const st = ctx.currentFlow()[AS_(ctx).cursor];
    if(!st || st.kind === 'exercise') return;
    ctx.advanceForm();
  }
  throw new Error('skipForm never reached an exercise');
}
function logSet(ctx, reps){
  ctx.document.getElementById('rep-input').value = String(reps);
  ctx.logRepSet();
  if(AS_(ctx) && (AS_(ctx).phase === 'rest' || AS_(ctx).phase === 'restComplete')) ctx.endRestNow();
}
function logWholeExercise(ctx, reps){
  const st = ctx.currentFlow()[AS_(ctx).cursor];
  const ex = ctx.EXERCISE_LIBRARY[st.exId];
  for(let i=0;i<ex.sets;i++){
    if(AS_(ctx).phase === 'coreFork') return;
    const cur = ctx.currentFlow()[AS_(ctx).cursor];
    if(ctx.EXERCISE_LIBRARY[cur.exId] && ctx.isDurationUnit(ctx.EXERCISE_LIBRARY[cur.exId].unit)){
      ctx.startDurationSet(); ctx.finishDurationEarly();
      if(AS_(ctx) && (AS_(ctx).phase === 'rest' || AS_(ctx).phase === 'restComplete')) ctx.endRestNow();
    } else logSet(ctx, reps);
  }
}
// Start a session, do one exercise, then end it (the Session Log row that results is what we date).
function startAndStop(ctx){
  if(ctx.needsArmCheck && ctx.needsArmCheck(ctx.getState())) ctx.recordArmCheck('same');
  ctx.startSession('RP');
  assert.ok(AS_(ctx), 'session started');
  skipForm(ctx);
  logWholeExercise(ctx, 5);
  ctx.finalizeSession('stopped');
  assert.equal(AS_(ctx), null, 'session finalized');
  return ctx.getState().log.slice(-1)[0];
}

// Shared seeds: the recovery layer is on (as on his phone) so templates match the live app.
function seed(extra){
  return Object.assign({ schemaVersion:8, progressionEngineVersion:3, rotationIndex:0, nextSessionOverride:null, nextSessionSequence:0,
    pendingDeletes:[], activeSession:null, legacy:{ promotions:{}, exerciseVariations:{}, promotionLog:[] }, anchorProgress:{}, log:[] }, extra || {});
}

test('clock harness: 8:30 PM EDT is already tomorrow in UTC, and localDay says today', () => {
  const { ctx, clock } = boot({ seed: seed() });
  assert.equal(new clock.Date().toISOString(), '2026-10-19T00:30:00.000Z');
  assert.equal(ctx.localDay(), '2026-10-18');
  assert.equal(ctx.localDay(EST_EVENING), '2026-11-05');
});

test('ring session finished at 8:30 PM EDT is dated the local day; completedAt keeps the UTC instant', () => {
  const { ctx } = boot({ seed: seed() });
  const e = startAndStop(ctx);
  assert.equal(e.date, '2026-10-18');
  assert.equal(e.completedAt, '2026-10-19T00:30:00.000Z');
  assert.equal(e.sessionType, 'RP');
});

test('ring session finished at 7:30 PM EST (after the clocks change) is dated the local day', () => {
  const { ctx } = boot({ seed: seed(), now: EST_EVENING });
  const e = startAndStop(ctx);
  assert.equal(e.date, '2026-11-05');
  assert.equal(e.completedAt, '2026-11-06T00:30:00.000Z');
});

test('an expired park is dated the day it was parked, not the day it expired', () => {
  const { ctx, clock } = boot({ seed: seed() });
  if(ctx.needsArmCheck(ctx.getState())) ctx.recordArmCheck('same');
  ctx.startSession('RP'); skipForm(ctx); logSet(ctx, 5);   // one set in, core not done
  ctx.parkSession();                                  // 8:30 PM EDT, Oct 18
  const parked = ctx.getState().activeSession;
  assert.ok(parked && parked.parkedAt === EDT_EVENING);
  assert.equal(parked.parkExpiresAt, Date.UTC(2026, 9, 20, 4, 0, 0), 'bound = end of Oct 19 local (00:00 EDT Oct 20)');
  clock.now = Date.UTC(2026, 9, 20, 13, 0, 0);        // Oct 20, 9:00 AM EDT: first Home render past the bound
  ctx.renderHome();
  const e = ctx.getState().log.slice(-1)[0];
  assert.equal(ctx.getState().activeSession, null, 'park finalized lazily');
  assert.equal(e.date, '2026-10-18');
  assert.equal(e.sessionStatus, 'partial');
  assert.equal(e.completedAt, '2026-10-20T13:00:00.000Z');
});

test("PT's list finished at 8:30 PM EDT is dated the local day it was started", () => {
  const { ctx, clock } = boot({ seed: seed() });
  ctx.recordArmCheck('same');
  ctx.startPtSession();
  assert.ok(ctx.__PTS(), 'PT session open');
  const items = ctx.PT_LIST.items;
  items.forEach((it,i)=>{ if((it.block || 'pt') === 'pt'){ ctx.ptOpen(i); ctx.ptItemDone('done'); } });
  clock.now += 6 * 60 * 1000;                          // six minutes later, still the same evening
  ctx.finishPtSession();
  const e = ctx.getState().log.slice(-1)[0];
  assert.equal(e.sessionType, 'PT');
  assert.equal(e.date, '2026-10-18');
  assert.equal(e.startedAt, '2026-10-19T00:30:00.000Z');
  assert.equal(e.completedAt, '2026-10-19T00:36:00.000Z');
  assert.equal(ctx.ptDoneToday(ctx.getState()), true, "counts as today's PT list");
});

test("PT's list at 7:30 PM EST is dated the local day", () => {
  const { ctx } = boot({ seed: seed(), now: EST_EVENING });
  ctx.recordArmCheck('same');
  ctx.startPtSession();
  const items = ctx.PT_LIST.items;
  items.forEach((it,i)=>{ if((it.block || 'pt') === 'pt'){ ctx.ptOpen(i); ctx.ptItemDone('done'); } });
  ctx.finishPtSession();
  assert.equal(ctx.getState().log.slice(-1)[0].date, '2026-11-05');
});

test('a park across the Nov 1 clock change, reopened days later, is dated the day it was parked', () => {
  const { ctx, clock } = boot({ seed: seed(), now: Date.UTC(2026, 10, 1, 0, 30, 0) });   // Oct 31, 8:30 PM EDT
  if(ctx.needsArmCheck(ctx.getState())) ctx.recordArmCheck('same');
  ctx.startSession('RP'); skipForm(ctx); logSet(ctx, 5);
  ctx.parkSession();
  const parked = ctx.getState().activeSession;
  assert.equal(ctx.localDay(parked.parkedAt), '2026-10-31');
  assert.equal(parked.parkExpiresAt, Date.UTC(2026, 10, 2, 5, 0, 0), 'bound = end of Nov 1 local = 00:00 EST Nov 2 (after the change)');
  clock.now = Date.UTC(2026, 10, 3, 23, 0, 0);        // Nov 3, 6:00 PM EST: days later
  ctx.renderHome();
  const e = ctx.getState().log.slice(-1)[0];
  assert.equal(ctx.getState().activeSession, null);
  assert.equal(e.date, '2026-10-31');
  assert.equal(e.completedAt, '2026-11-03T23:00:00.000Z');
});

test("PT's list started before midnight and finished after is dated its start day", () => {
  const { ctx, clock } = boot({ seed: seed(), now: Date.UTC(2026, 9, 19, 3, 55, 0) });   // Oct 18, 11:55 PM EDT
  ctx.recordArmCheck('same');
  ctx.startPtSession();
  const items = ctx.PT_LIST.items;
  items.forEach((it,i)=>{ if((it.block || 'pt') === 'pt'){ ctx.ptOpen(i); ctx.ptItemDone('done'); } });
  clock.now += 10 * 60 * 1000;                         // 12:05 AM Oct 19
  ctx.finishPtSession();
  const e = ctx.getState().log.slice(-1)[0];
  assert.equal(e.date, '2026-10-18');
  assert.equal(e.completedAt, '2026-10-19T04:05:00.000Z');
  assert.equal(ctx.ptDoneToday(ctx.getState()), false, 'on Oct 19 the list is open again (it counted for Oct 18)');
});

test('no UTC-date idiom remains in the app script', () => {
  const html = readFileSync(join(root,'index.html'),'utf8');
  assert.equal(html.includes("toISOString().split('T')[0]"), false);
});

// Export ---------------------------------------------------------------------------
function sharingNavigator(shares, canShareCalls, canShare = true, shareImpl){
  return () => ({
    canShare(data){ canShareCalls.push(data); return canShare; },
    share(data){ shares.push(data); return shareImpl ? shareImpl(data) : Promise.resolve(); }
  });
}

test('Export uses the share sheet when files can be shared; the blob link is not touched', async () => {
  const { ctx, shares, canShareCalls, urls, created } = boot({ seed: seed({ log:[] }), navigator: sharingNavigator([], []) });
  const sharesSeen = []; const canSeen = [];
  ctx.navigator = sharingNavigator(sharesSeen, canSeen)();
  ctx.exportData();
  await Promise.resolve();
  assert.equal(canSeen.length, 1);
  assert.equal(sharesSeen.length, 1, 'share sheet opened');
  const f = sharesSeen[0].files[0];
  assert.equal(f.name, 'train-backup-2026-10-18.json', 'file named by the local day');
  assert.equal(f.type, 'application/json');
  const parsed = JSON.parse(f.parts.join(''));
  assert.equal(parsed.schemaVersion, ctx.getState().schemaVersion);
  assert.ok(Array.isArray(parsed.log));
  assert.equal(urls.created, 0, 'no object URL');
  assert.equal(created.filter(el=> el.clicks > 0).length, 0, 'no synthetic download click');
  void shares; void canShareCalls;
});

test('Export falls back to the blob link only when files cannot be shared', () => {
  // canShare says no
  let b = boot({ seed: seed() });
  b.ctx.navigator = sharingNavigator([], [], false)();
  b.ctx.exportData();
  assert.equal(b.urls.created, 1); assert.equal(b.urls.revoked, 1);
  assert.equal(b.created.filter(el=> el.clicks > 0).length, 1, 'download link clicked');
  assert.equal(b.created.find(el=> el.clicks > 0).download, 'train-backup-2026-10-18.json');
  // no share API at all (desktop browsers)
  b = boot({ seed: seed() });
  b.ctx.navigator = {};
  b.ctx.exportData();
  assert.equal(b.urls.created, 1);
  // share exists but File does not
  b = boot({ seed: seed(), noFile: true });
  b.ctx.navigator = sharingNavigator([], [])();
  b.ctx.exportData();
  assert.equal(b.urls.created, 1);
});

test('a cancelled share sheet is silent; any other share failure offers a download, never auto-downloads', async () => {
  let b = boot({ seed: seed() });
  const abort = Object.assign(new Error('cancelled'), { name:'AbortError' });
  b.ctx.navigator = sharingNavigator([], [], true, () => Promise.reject(abort))();
  b.ctx.exportData();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(b.urls.created, 0);
  assert.equal(b.ctx.document.getElementById('modal-title').textContent, '', 'no modal on cancel');

  b = boot({ seed: seed() });
  const denied = Object.assign(new Error('nope'), { name:'NotAllowedError' });
  b.ctx.navigator = sharingNavigator([], [], true, () => Promise.reject(denied))();
  b.ctx.exportData();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(b.urls.created, 0, 'no automatic blob download after a failed share');
  assert.match(b.ctx.document.getElementById('modal-title').textContent, /share sheet/i);
});
