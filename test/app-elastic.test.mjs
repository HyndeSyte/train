// v7 elastic-sessions acceptance harness. Extracts the inline app script from index.html
// and runs it in a stubbed-DOM Node context, then exercises the red-teamed invariants:
// core gate, fork, park (timer freeze + lazy bounded expiry), credit-follows-work scoring,
// rotation/override consumption, the Stopped-RPush +5 lb migration fixture, and active-time
// duration. Run: node --test test/  (or node --test test/app-elastic.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function makeEl(){
  return { innerHTML:'', textContent:'', value:'', checked:false, style:{}, onclick:null,
    classList:{ _s:new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, toggle(c,f){ if(f===undefined) f=!this._s.has(c); f?this._s.add(c):this._s.delete(c); return f; } } };
}

// Fresh app context per test. Returns { ctx, els, storage } — ctx has every app global.
function boot(opts = {}){
  const els = {};
  const storage = new Map(opts.seed ? [['train_state', JSON.stringify(opts.seed)]] : []);
  const documentStub = {
    getElementById(id){ if(!els[id]) els[id] = makeEl(); return els[id]; },
    querySelectorAll(){ return []; },
    addEventListener(){}, createElement(){ return makeEl(); },
    body:{ addEventListener(){}, innerHTML:'' }
  };
  const ctx = {
    localStorage:{ getItem:k=>storage.has(k)?storage.get(k):null, setItem:(k,v)=>storage.set(k,String(v)), removeItem:k=>storage.delete(k) },
    document: documentStub, navigator:{}, console, setTimeout, clearTimeout,
    Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Promise, crypto: undefined,
    alert(){}, prompt(){ return null; },
    fetch(){ return Promise.reject(new Error('no network in tests')); },
    URL:{ createObjectURL(){ return ''; }, revokeObjectURL(){} }, Blob: class {}, FileReader: class {},
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(root,'data.js'),'utf8'), ctx);
  const html = readFileSync(join(root,'index.html'),'utf8');
  const m = /<script>\n([\s\S]*)\n<\/script>/.exec(html);
  assert.ok(m, 'inline app script found');
  vm.runInContext(m[1] + '\n;globalThis.__AS = () => AS; globalThis.__setAS = (v) => { AS = v; };', ctx);
  return { ctx, els, storage };
}

const AS_ = (c) => c.__AS();

// Drive helpers -------------------------------------------------------------
function skipForm(ctx){
  // Advance through form + activation stations until the cursor sits on an exercise.
  let guard = 0;
  while(guard++ < 20){
    const flow = ctx.currentFlow();
    const st = flow[AS_(ctx).cursor];
    if(!st || st.kind === 'exercise') return;
    ctx.advanceForm();
  }
  throw new Error('skipForm never reached an exercise');
}
function logSet(ctx, reps){
  const els = ctx.document.getElementById('rep-input');
  els.value = String(reps);
  ctx.logRepSet();
  // logging starts a rest for all but the final station set; end it deterministically
  if(AS_(ctx) && (AS_(ctx).phase === 'rest' || AS_(ctx).phase === 'restComplete')) ctx.endRestNow();
}
function logWholeExercise(ctx, reps){
  const flow = ctx.currentFlow();
  const st = flow[AS_(ctx).cursor];
  const ex = ctx.EXERCISE_LIBRARY[st.exId];
  for(let i=0;i<ex.sets;i++){
    if(AS_(ctx).phase === 'coreFork') return; // fork interposed mid-drive
    if(ctx.EXERCISE_LIBRARY[flow[AS_(ctx).cursor].exId] && ctx.isDurationUnit(ctx.EXERCISE_LIBRARY[flow[AS_(ctx).cursor].exId].unit)){
      ctx.startDurationSet(); ctx.finishDurationEarly();
      if(AS_(ctx) && (AS_(ctx).phase === 'rest' || AS_(ctx).phase === 'restComplete')) ctx.endRestNow();
    } else {
      logSet(ctx, reps);
    }
  }
}
function completeGate(ctx, reps){
  // Log every gate exercise fully (assumes cursor at/before them in flow order).
  let guard = 0;
  while(guard++ < 40){
    if(AS_(ctx).phase === 'coreFork') return;
    const flow = ctx.currentFlow();
    const st = flow[AS_(ctx).cursor];
    if(!st) return;
    if(st.kind !== 'exercise'){ ctx.advanceForm(); continue; }
    logWholeExercise(ctx, reps);
  }
}

// ---------------------------------------------------------------------------
test('flow: MVS has no Form; RP has activation; LP does not', () => {
  const { ctx } = boot();
  const mvs = ctx.buildFlow('MVS');
  assert.ok(mvs.every(st=>st.kind !== 'form'), 'MVS skips the Form');
  const rp = ctx.buildFlow('RP');
  assert.ok(rp.some(st=>st.kind === 'activation'), 'RP includes activation');
  assert.equal(rp.filter(st=>st.kind==='form').length, ctx.FORM.screens.length);
  const lp = ctx.buildFlow('LP');
  assert.ok(lp.every(st=>st.kind !== 'activation'), 'LP has no activation');
  // core flags: LP opener+anchor core; only anchor gated
  const lpCore = lp.filter(st=>st.core).map(st=>st.exId);
  assert.equal(JSON.stringify(lpCore), JSON.stringify(['ring-support','split-squat']));
  assert.equal(JSON.stringify(lp.filter(st=>st.gate).map(st=>st.exId)), JSON.stringify(['split-squat']));
  // RPr gate = the Ring Practice pair
  assert.equal(JSON.stringify(ctx.templateGateSlots('RPr').map(g=>g.exId)), JSON.stringify(['ring-row','ring-face-pull']));
});

test('gate + fork: RP anchor complete -> coreFork; Finish -> Completed, rotation advances, override consumed', () => {
  const { ctx } = boot();
  ctx.setSessionOverride('RP'); // rotation default is already RP (index 0) — set an override anyway
  ctx.startSession('RP');
  skipForm(ctx);
  logWholeExercise(ctx, 4); // 4x4 = 16, all sets logged
  assert.equal(AS_(ctx).phase, 'coreFork', 'fork shown after gate earned');
  assert.equal(ctx.liveCoreComplete(), true);
  ctx.finishAtFork();
  ctx.finalizeSession('completed');
  const s = ctx.getState();
  const e = s.log[s.log.length-1];
  assert.equal(e.sessionStatus, 'completed');
  assert.equal(e.coreComplete, true);
  assert.equal(s.rotationIndex, 1, 'advanced from logged RP');
  assert.equal(s.nextSessionOverride, null, 'override consumed on core-complete');
  assert.ok(e.duration >= 1);
});

test('gate not earned: skipped anchor set -> no fork; full run ends partial; rotation holds; override preserved', () => {
  const { ctx } = boot();
  ctx.setSessionOverride('RPush');
  ctx.startSession('RPush');
  skipForm(ctx);
  // anchor: log 3, skip the 4th
  logSet(ctx, 8); logSet(ctx, 8); logSet(ctx, 8);
  ctx.skipCurrentSet();
  assert.notEqual(AS_(ctx).phase, 'coreFork', 'no fork without the gate');
  // run out the rest of the session
  completeGate(ctx, 6);
  ctx.finalizeSession('completed');
  const s = ctx.getState();
  const e = s.log[s.log.length-1];
  assert.equal(e.coreComplete, false);
  assert.equal(e.sessionStatus, 'partial');
  assert.equal(s.rotationIndex, 0, 'rotation held');
  assert.equal(s.nextSessionOverride, 'RPush', 'override preserved');
});

test('credit follows work: Stopped session with complete anchor SCORES; one-set stop does not', () => {
  const { ctx } = boot();
  ctx.startSession('RPush');
  skipForm(ctx);
  logWholeExercise(ctx, 8); // 8/8/8/8 = 32 = owned top
  if(AS_(ctx).phase === 'coreFork') ctx.keepGoingFromFork();
  ctx.finalizeSession('stopped');
  let s = ctx.getState();
  let e = s.log[s.log.length-1];
  assert.equal(e.sessionStatus, 'stopped', 'Stopped survives as the status');
  assert.equal(e.coreComplete, true);
  const prog = s.anchorProgress['RPush_anchor_ring-pushup'];
  assert.ok(prog, 'stopped session scored');
  assert.equal(prog.externalLoad, 5, 'owned top -> stepped up');
  assert.equal(prog.creditedQualityReps, null, 're-baselining at the new load');
  assert.equal(s.rotationIndex, 3, 'core-complete stop advances from logged RPush (idx2 -> 3)');
  // one-great-set exploit earns nothing
  const b2 = boot();
  b2.ctx.startSession('RP');
  skipForm(b2.ctx);
  logSet(b2.ctx, 6);
  b2.ctx.finalizeSession('stopped');
  s = b2.ctx.getState();
  assert.equal(s.anchorProgress['RP_anchor_ring-pullup'], undefined, 'incomplete anchor never scores');
  assert.equal(s.rotationIndex, 0, 'pre-core stop holds rotation');
});

test('park: freezes a live rest timer via pause semantics; resume un-parks with timer paused', () => {
  const { ctx } = boot();
  ctx.startSession('RP');
  skipForm(ctx);
  const els = ctx.document.getElementById('rep-input');
  els.value = '5';
  ctx.logRepSet(); // starts a 2:30 rest (more sets remain)
  assert.equal(AS_(ctx).phase, 'rest');
  assert.ok(AS_(ctx).timerEnd, 'rest timer live');
  ctx.parkSession();
  const s = ctx.getState();
  const a = s.activeSession;
  assert.ok(a, 'session persisted');
  assert.ok(a.parkedAt, 'parked');
  assert.equal(a.timerEnd, null, 'wall-clock deadline cleared');
  assert.ok(a.timerRemaining > 0 && a.timerRemaining <= 150000, 'remaining captured');
  assert.equal(a.phase, 'restPaused');
  assert.equal(a.lastActiveAt, null, 'active clock frozen');
  // fixed bound: end of the following local day
  const d = new Date(a.parkedAt); d.setHours(0,0,0,0); d.setDate(d.getDate()+2);
  assert.equal(a.parkExpiresAt, d.getTime());
  assert.equal(AS_(ctx), null, 'left the session');
  ctx.resumeSession();
  assert.ok(AS_(ctx) && !AS_(ctx).parkedAt, 'un-parked on resume');
  assert.equal(AS_(ctx).phase, 'restPaused', 'timer stays paused — user restarts deliberately');
});

test('park expiry (lazy): pre-core -> Partial, rotation holds, override preserved; core-complete -> Completed + advance', () => {
  // pre-core case
  let b = boot();
  b.ctx.setSessionOverride('LS');
  b.ctx.startSession('LS');
  skipForm(b.ctx);
  logSet(b.ctx, 15); // one opener set only — nowhere near the gate
  b.ctx.parkSession();
  let s = b.ctx.getState();
  s.activeSession.parkExpiresAt = Date.now() - 1000; // force the bound into the past
  b.ctx.saveState(s);
  b.ctx.renderHome(); // lazy enforcement point
  s = b.ctx.getState();
  assert.equal(s.activeSession, null, 'expired park finalized');
  let e = s.log[s.log.length-1];
  assert.equal(e.sessionStatus, 'partial');
  assert.equal(e.coreComplete, false);
  assert.equal(s.rotationIndex, 0, 'rotation held');
  assert.equal(s.nextSessionOverride, 'LS', 'override preserved through expiry');
  // core-complete case
  b = boot();
  b.ctx.startSession('LP');
  skipForm(b.ctx);
  completeGate(b.ctx, 8); // opener + anchor -> gate earned -> fork
  assert.equal(AS_(b.ctx).phase, 'coreFork');
  b.ctx.keepGoingFromFork();
  b.ctx.parkSession();
  s = b.ctx.getState();
  s.activeSession.parkExpiresAt = Date.now() - 1000;
  b.ctx.saveState(s);
  b.ctx.renderHome();
  s = b.ctx.getState();
  e = s.log[s.log.length-1];
  assert.equal(e.sessionStatus, 'completed', 'core-complete park expiry saves as Completed');
  assert.equal(e.coreComplete, true);
  assert.equal(s.rotationIndex, 2, 'advanced from logged LP (idx1 -> 2)');
});

test('MVS floor: completes, counts, never advances rotation, never consumes an override', () => {
  const { ctx } = boot();
  ctx.setSessionOverride('RPush');
  ctx.startSession('MVS');
  assert.ok(ctx.currentFlow().every(st=>st.kind !== 'form'));
  completeGate(ctx, 10);
  // gate earned but nothing after core -> no fork; cursor at end -> completion
  assert.notEqual(AS_(ctx).phase, 'coreFork');
  ctx.finalizeSession('completed');
  const s = ctx.getState();
  const e = s.log[s.log.length-1];
  assert.equal(e.sessionType, 'MVS');
  assert.equal(e.sessionStatus, 'completed');
  assert.equal(e.coreComplete, true);
  assert.equal(e.overrideUsed, false, 'MVS is not an override use');
  assert.equal(s.rotationIndex, 0, 'rotation untouched');
  assert.equal(s.nextSessionOverride, 'RPush', 'override preserved');
});

test('MIGRATION FIXTURE: real July log shapes — stopped RPush 8/8/8/8 steps to +5 lb on v7 migrate; RP partial result unchanged', () => {
  // Shapes mirror the live Session Log rows: 2026-06-10 RP partial (24 raw, scored, stepped
  // to +5, re-baselining) and 2026-07-02 RPush stopped (32 raw, formerly unscored).
  const seed = {
    schemaVersion: 6, progressionEngineVersion: 2, rotationIndex: 1, nextSessionOverride: 'LP',
    nextSessionSequence: 7, pendingDeletes: [], activeSession: null,
    legacy:{ promotions:{}, exerciseVariations:{}, promotionLog:[] },
    anchorProgress: { 'RP_anchor_ring-pullup': { exId:'ring-pullup', label:'Heavy Pull', lastRawQualityReps:24, creditedQualityReps:null, previousCreditedQualityReps:24, creditCapped:false, externalLoad:5, loadUnit:'lb', variationId:null, lastDate:'2026-06-10', steppedUp:true } },
    log: [
      { date:'2026-06-10', sessionType:'RP', sessionStatus:'partial', sessionId:'11111111-aaaa', sessionSequence:5,
        performed:[ { slotId:'RP_anchor_ring-pullup', exId:'ring-pullup', role:'anchor', progressionType:'heavyAnchor', reps:[6,6,6,6] } ] },
      { date:'2026-07-02', sessionType:'RPush', sessionStatus:'stopped', sessionId:'22222222-bbbb', sessionSequence:6,
        performed:[ { slotId:'RPush_anchor_ring-pushup', exId:'ring-pushup', role:'anchor', progressionType:'heavyAnchor', reps:[8,8,8,8] } ] }
    ]
  };
  const { ctx } = boot({ seed });
  const s = ctx.getState(); // triggers migrate()
  assert.equal(s.progressionEngineVersion, 3);
  assert.equal(s.schemaVersion, 7);
  const rp = s.anchorProgress['RP_anchor_ring-pullup'];
  assert.equal(rp.externalLoad, 5, 'RP result unchanged by replay');
  assert.equal(rp.creditedQualityReps, null);
  const rpush = s.anchorProgress['RPush_anchor_ring-pushup'];
  assert.ok(rpush, 'stopped RPush now scores');
  assert.equal(rpush.externalLoad, 5, 'EXPECTED: 32 = owned top -> +5 lb step');
  assert.equal(rpush.creditedQualityReps, null, 're-baselining at the new load');
  assert.equal(rpush.lastRawQualityReps, 32);
  // migration never touches rotation or override
  assert.equal(s.rotationIndex, 1);
  assert.equal(s.nextSessionOverride, 'LP');
  // coreComplete backfilled from performed[] against current templates
  assert.equal(s.log[0].coreComplete, true);
  assert.equal(s.log[1].coreComplete, true);
  // idempotent: second migrate pass changes nothing
  const again = ctx.migrate(JSON.parse(JSON.stringify(s)));
  assert.equal(JSON.stringify(again.anchorProgress), JSON.stringify(s.anchorProgress));
});

test('history delete rebuild: replays stopped entries too; rotation + override untouched', () => {
  const seed = {
    schemaVersion: 6, progressionEngineVersion: 2, rotationIndex: 4, nextSessionOverride: 'RP',
    nextSessionSequence: 3, pendingDeletes: [], activeSession: null,
    legacy:{ promotions:{}, exerciseVariations:{}, promotionLog:[] }, anchorProgress:{},
    log: [
      { date:'2026-08-01', sessionType:'RP', sessionStatus:'stopped', sessionId:'33333333-cccc', sessionSequence:0,
        performed:[ { slotId:'RP_anchor_ring-pullup', exId:'ring-pullup', role:'anchor', progressionType:'heavyAnchor', reps:[5,5,5,5] } ] },
      { date:'2026-08-03', sessionType:'LP', sessionStatus:'completed', sessionId:'44444444-dddd', sessionSequence:1,
        performed:[ { slotId:'LP_anchor_split-squat', exId:'split-squat', role:'anchor', progressionType:'loose', reps:[8,8,8] } ] }
    ]
  };
  const { ctx } = boot({ seed });
  let s = ctx.getState();
  assert.equal(s.anchorProgress['RP_anchor_ring-pullup'].lastRawQualityReps, 20, 'stopped RP scored in rebuild');
  ctx.deleteLogEntry(1); // delete the LP entry
  s = ctx.getState();
  assert.equal(s.log.length, 1);
  assert.ok(s.anchorProgress['RP_anchor_ring-pullup'], 'rebuild kept the stopped RP score');
  assert.equal(s.rotationIndex, 4, 'rotation untouched by delete/rebuild');
  assert.equal(s.nextSessionOverride, 'RP', 'override untouched by delete/rebuild');
});

test('regression: all 6 session types build; legacy pre-engine entry no-ops; invalid override cleared, valid preserved', () => {
  const { ctx } = boot();
  ['RP','LP','RPush','LS','RPr','MVS'].forEach(t=>{
    const flow = ctx.buildFlow(t);
    assert.ok(flow.length > 0);
    const uids = flow.map(st=>st.uid);
    assert.equal(new Set(uids).size, uids.length, `uids collision-free for ${t}`);
  });
  // pre-engine entry (no performed[]) no-ops in replay and yields null coreComplete
  const seed = { schemaVersion:6, progressionEngineVersion:2, rotationIndex:0, nextSessionOverride:'BAD',
    nextSessionSequence:1, pendingDeletes:[], activeSession:null,
    legacy:{ promotions:{}, exerciseVariations:{}, promotionLog:[] }, anchorProgress:{},
    log:[ { date:'2026-03-29', sessionType:'U1', sessionStatus:'completed', sessionId:'55555555-eeee', sessionSequence:0, exercises:{ 'ring-row':[8,8,8] } } ] };
  const b = boot({ seed });
  const s = b.ctx.getState();
  assert.equal(JSON.stringify(s.anchorProgress), '{}', 'legacy entry no-ops');
  assert.equal(s.log[0].coreComplete, null, 'unknown template -> null, not false');
  assert.equal(s.nextSessionOverride, null, 'invalid override cleared');
  const b2 = boot({ seed: { ...seed, nextSessionOverride:'LS', log:[] } });
  assert.equal(b2.ctx.getState().nextSessionOverride, 'LS', 'valid override preserved');
});

test('active-time duration: idle gaps capped, park freezes the clock', () => {
  const { ctx } = boot();
  ctx.startSession('RP');
  skipForm(ctx);
  // simulate a 3-hour-old lastActiveAt (left the phone) — cap keeps it to <= 10 min
  AS_(ctx).lastActiveAt = Date.now() - 3*60*60*1000;
  ctx.persistAS();
  assert.ok(AS_(ctx).activeMs <= 10*60*1000 + 1000, 'gap capped');
  // park two days, then finalize: duration reflects active time only
  ctx.parkSession();
  const s = ctx.getState();
  s.activeSession.parkedAt = Date.now() - 2*24*60*60*1000;
  s.activeSession.parkExpiresAt = Date.now() - 1000;
  ctx.saveState(s);
  ctx.renderHome();
  const e = ctx.getState().log.slice(-1)[0];
  assert.ok(e.duration <= 15, `duration is active minutes, got ${e.duration}`);
});

test('sync payload carries coreComplete; statusToNotion unchanged', () => {
  const { ctx } = boot();
  const p = ctx.buildSyncPayload({ sessionId:'x'.repeat(12), sessionSequence:1, date:'2026-08-16',
    sessionType:'MVS', sessionStatus:'completed', coreComplete:true, performed:[], exerciseMeta:{}, issues:[] });
  assert.equal(p.coreComplete, true);
  assert.equal(p.status, 'Completed');
  assert.equal(ctx.statusToNotion('stopped'), 'Stopped');
});
