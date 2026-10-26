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
  const n = ctx.setsFor(st);
  for(let i=0;i<n;i++){
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
// v8: log everything until the cursor reaches `exId` (forms advanced, earlier exercises logged).
function driveTo(ctx, exId, reps = 6){
  let guard = 0;
  while(guard++ < 60){
    const flow = ctx.currentFlow();
    const st = flow[AS_(ctx).cursor];
    if(!st) throw new Error('driveTo ran past the flow looking for ' + exId);
    if(st.kind !== 'exercise'){ ctx.advanceForm(); continue; }
    if(st.exId === exId) return;
    logWholeExercise(ctx, reps);
    if(AS_(ctx).phase === 'coreFork') ctx.keepGoingFromFork();
  }
  throw new Error('driveTo never reached ' + exId);
}

test('flow (v8): A/B/C open with the opener; Floor keeps the kata and gates on the get-up; legacy keys still build', () => {
  const { ctx } = boot();
  const a = ctx.buildFlow('A');
  assert.equal(a[0].uid, 'opener', 'A opens with the opener');
  assert.equal(a.filter(st=>st.kind==='form').length, 1);
  assert.equal(JSON.stringify(a.filter(st=>st.gate).map(st=>st.exId)), JSON.stringify(['split-squat','ring-pullup','para-pushup']));
  assert.equal(JSON.stringify(a.filter(st=>st.core && !st.gate).map(st=>st.exId)), JSON.stringify(['squat-jump']), 'power is core, never gate');
  assert.equal(a.find(st=>st.exId==='ring-pullup').sets, 2, 'block sets override the library default');
  assert.equal(a.find(st=>st.exId==='ring-pullup').slotId, 'A_anchor_ring-pullup');
  const b = ctx.buildFlow('B');
  assert.ok(b.every(st=>st.kind !== 'activation'), 'normal B has no shoulder prep');
  assert.equal(b.find(st=>st.exId==='hinge-rdl').sets, 3);
  const c = ctx.buildFlow('C');
  assert.equal(c.find(st=>st.exId==='ring-pushup').slotId, 'C_anchor_ring-pushup');
  const mvs = ctx.buildFlow('MVS');
  assert.equal(mvs[0].uid, 'form-all', 'Floor keeps the full kata');
  assert.equal(JSON.stringify(mvs.filter(st=>st.gate).map(st=>st.exId)), JSON.stringify(['floor-getup']));
  ['RP','LP','RPush','LS','RPr'].forEach(t=> assert.ok(ctx.buildFlow(t).length > 0, `legacy ${t} still builds`));
  assert.equal(JSON.stringify([0,1,2].map(i=> ctx.getDefaultSessionType({ rotationIndex:i }))), JSON.stringify(['A','B','C']));
});

test('gate + fork (v8): A gate complete -> coreFork; Finish -> Completed, rotation advances, override consumed', () => {
  const { ctx } = boot();
  ctx.setSessionOverride('A');
  ctx.startSession('A');
  completeGate(ctx, 6);
  assert.equal(AS_(ctx).phase, 'coreFork', 'fork shown after gate earned');
  assert.equal(ctx.liveCoreComplete(), true);
  ctx.finishAtFork();
  ctx.finalizeSession('completed');
  const s = ctx.getState();
  const e = s.log[s.log.length-1];
  assert.equal(e.sessionStatus, 'completed');
  assert.equal(e.coreComplete, true);
  assert.equal(s.rotationIndex, 1, 'advanced from logged A');
  assert.equal(s.nextSessionOverride, null, 'override consumed on core-complete');
  const pull = e.performed.find(p=> p.exId === 'ring-pullup');
  assert.equal(pull.targetSets, 2, 'the session set count is stored on the entry');
  assert.ok(e.duration >= 1);
});

test('gate not earned (v8): skipped anchor set -> no fork; full run ends partial; rotation holds; override preserved', () => {
  const { ctx } = boot();
  ctx.setSessionOverride('C');
  ctx.startSession('C');
  driveTo(ctx, 'ring-pushup');
  logSet(ctx, 8);
  ctx.skipCurrentSet();
  assert.notEqual(AS_(ctx).phase, 'coreFork', 'no fork without the gate');
  completeGate(ctx, 6);
  ctx.finalizeSession('completed');
  const s = ctx.getState();
  const e = s.log[s.log.length-1];
  assert.equal(e.coreComplete, false);
  assert.equal(e.sessionStatus, 'partial');
  assert.equal(s.rotationIndex, 0, 'rotation held');
  assert.equal(s.nextSessionOverride, 'C', 'override preserved');
});

test('credit follows work (v8): stopped A with a complete anchor SCORES on its 2-set top; a one-set stop does not', () => {
  const { ctx } = boot();
  ctx.startSession('A');
  driveTo(ctx, 'ring-pullup');
  logWholeExercise(ctx, 6);   // 6/6 = 12 = owned top for 2 sets
  driveTo(ctx, 'para-pushup');
  logWholeExercise(ctx, 8);
  if(AS_(ctx).phase === 'coreFork') ctx.keepGoingFromFork();
  ctx.finalizeSession('stopped');
  let s = ctx.getState();
  let e = s.log[s.log.length-1];
  assert.equal(e.sessionStatus, 'stopped', 'Stopped survives as the status');
  assert.equal(e.coreComplete, true);
  const prog = s.anchorProgress['A_anchor_ring-pullup'];
  assert.ok(prog, 'stopped session scored');
  assert.equal(prog.externalLoad, 5, 'owned top (2 x 6) -> stepped up');
  assert.equal(prog.creditedQualityReps, null, 're-baselining at the new load');
  assert.equal(s.rotationIndex, 1, 'core-complete stop advances from logged A');
  const b2 = boot();
  b2.ctx.startSession('A');
  driveTo(b2.ctx, 'ring-pullup');
  logSet(b2.ctx, 6);
  b2.ctx.finalizeSession('stopped');
  s = b2.ctx.getState();
  assert.equal(s.anchorProgress['A_anchor_ring-pullup'], undefined, 'incomplete anchor never scores');
  assert.equal(s.rotationIndex, 0, 'pre-core stop holds rotation');
});

test('park: freezes a live rest timer via pause semantics; resume un-parks with timer paused', () => {
  const { ctx } = boot();
  ctx.startSession('A');
  driveTo(ctx, 'ring-pullup');
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
  const d = new Date(a.parkedAt); d.setHours(0,0,0,0); d.setDate(d.getDate()+2);
  assert.equal(a.parkExpiresAt, d.getTime());
  assert.equal(AS_(ctx), null, 'left the session');
  ctx.resumeSession();
  assert.ok(AS_(ctx) && !AS_(ctx).parkedAt, 'un-parked on resume');
  assert.equal(AS_(ctx).phase, 'restPaused', 'timer stays paused — user restarts deliberately');
});

test('park expiry (lazy): pre-core -> Partial, rotation holds, override preserved; core-complete -> Completed + advance', () => {
  let b = boot();
  b.ctx.setSessionOverride('B');
  b.ctx.startSession('B');
  skipForm(b.ctx);
  logSet(b.ctx, 8); // one hinge set only — nowhere near the gate
  b.ctx.parkSession();
  let s = b.ctx.getState();
  s.activeSession.parkExpiresAt = Date.now() - 1000;
  b.ctx.saveState(s);
  b.ctx.renderHome();
  s = b.ctx.getState();
  assert.equal(s.activeSession, null, 'expired park finalized');
  let e = s.log[s.log.length-1];
  assert.equal(e.sessionStatus, 'partial');
  assert.equal(e.coreComplete, false);
  assert.equal(s.rotationIndex, 0, 'rotation held');
  assert.equal(s.nextSessionOverride, 'B', 'override preserved through expiry');
  b = boot();
  b.ctx.startSession('A');
  completeGate(b.ctx, 6);
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
  assert.equal(s.rotationIndex, 1, 'advanced from logged A');
});

test('Floor (v8): kata + get-up completes and counts; never advances rotation, never consumes an override', () => {
  const { ctx } = boot();
  ctx.setSessionOverride('C');
  ctx.startSession('MVS');
  assert.equal(ctx.currentFlow()[0].uid, 'form-all', 'Floor keeps the kata');
  completeGate(ctx, 4);
  assert.equal(AS_(ctx).phase, 'coreFork', 'Floor Extension follows the get-up');
  ctx.finishAtFork();
  ctx.finalizeSession('completed');
  const s = ctx.getState();
  const e = s.log[s.log.length-1];
  assert.equal(e.sessionType, 'MVS');
  assert.equal(e.sessionStatus, 'completed');
  assert.equal(e.coreComplete, true);
  assert.equal(e.overrideUsed, false, 'MVS is not an override use');
  assert.equal(s.rotationIndex, 0, 'rotation untouched');
  assert.equal(s.nextSessionOverride, 'C', 'override preserved');
});

test('MIGRATION FIXTURE: real July log shapes still replay exactly; v9 moves the rotation to A once and keeps a backup', () => {
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
  const { ctx, storage } = boot({ seed });
  const s = ctx.getState();
  assert.equal(s.progressionEngineVersion, 3);
  assert.equal(s.schemaVersion, 9);
  const rp = s.anchorProgress['RP_anchor_ring-pullup'];
  assert.equal(rp.externalLoad, 5, 'RP result unchanged by replay');
  assert.equal(rp.creditedQualityReps, null);
  const rpush = s.anchorProgress['RPush_anchor_ring-pushup'];
  assert.ok(rpush, 'stopped RPush scores (v7 top: 4 x 8)');
  assert.equal(rpush.externalLoad, 5, 'EXPECTED: 32 = owned v7 top -> +5 lb step');
  assert.equal(rpush.lastRawQualityReps, 32);
  assert.equal(s.rotationIndex, 0, 'v9: rotation starts at A');
  assert.equal(s.nextSessionOverride, null, 'v9: an override naming a retired key clears');
  assert.ok(storage.get('train_state_backup_pre_v9'), 'raw pre-v9 backup kept');
  assert.equal(s.log[0].coreComplete, true);
  assert.equal(s.log[1].coreComplete, true);
  const again = ctx.migrate(JSON.parse(JSON.stringify(s)));
  assert.equal(JSON.stringify(again.anchorProgress), JSON.stringify(s.anchorProgress));
  assert.equal(again.rotationIndex, 0);
});

test('history delete rebuild: replays stopped entries too; rotation + override untouched', () => {
  const seed = {
    schemaVersion: 9, progressionEngineVersion: 3, rotationIndex: 2, nextSessionOverride: 'B',
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
  s.anchorProgress = {}; ctx.rebuildAnchorProgress(s); ctx.saveState(s);
  assert.equal(s.anchorProgress['RP_anchor_ring-pullup'].lastRawQualityReps, 20, 'stopped RP scored in rebuild');
  ctx.deleteLogEntry(1);
  s = ctx.getState();
  assert.equal(s.log.length, 1);
  assert.ok(s.anchorProgress['RP_anchor_ring-pullup'], 'rebuild kept the stopped RP score');
  assert.equal(s.rotationIndex, 2, 'rotation untouched by delete/rebuild');
  assert.equal(s.nextSessionOverride, 'B', 'override untouched by delete/rebuild');
});

test('regression: every template builds with unique uids; legacy pre-engine entry no-ops; invalid override cleared, valid preserved', () => {
  const { ctx } = boot();
  Object.keys(ctx.SESSION_TEMPLATES).forEach(t=>{
    const flow = ctx.buildFlow(t);
    assert.ok(flow.length > 0);
    const uids = flow.map(st=>st.uid);
    assert.equal(new Set(uids).size, uids.length, `uids collision-free for ${t}`);
  });
  Object.keys(ctx.RECOVERY_TEMPLATES).forEach(t=>{
    const uids = ctx.buildFlowFrom(t, ctx.RECOVERY_TEMPLATES[t]).map(st=>st.uid);
    assert.equal(new Set(uids).size, uids.length, `recovery uids collision-free for ${t}`);
  });
  const seed = { schemaVersion:6, progressionEngineVersion:2, rotationIndex:0, nextSessionOverride:'BAD',
    nextSessionSequence:1, pendingDeletes:[], activeSession:null,
    legacy:{ promotions:{}, exerciseVariations:{}, promotionLog:[] }, anchorProgress:{},
    log:[ { date:'2026-03-29', sessionType:'U1', sessionStatus:'completed', sessionId:'55555555-eeee', sessionSequence:0, exercises:{ 'ring-row':[8,8,8] } } ] };
  const b = boot({ seed });
  const s = b.ctx.getState();
  assert.equal(JSON.stringify(s.anchorProgress), '{}', 'legacy entry no-ops');
  assert.equal(s.log[0].coreComplete, null, 'unknown template -> null, not false');
  assert.equal(s.nextSessionOverride, null, 'invalid override cleared');
  const b2 = boot({ seed: { ...seed, schemaVersion:9, nextSessionOverride:'B', log:[] } });
  assert.equal(b2.ctx.getState().nextSessionOverride, 'B', 'valid override preserved');
  const b3 = boot({ seed: { ...seed, schemaVersion:9, nextSessionOverride:'LS', log:[] } });
  assert.equal(b3.ctx.getState().nextSessionOverride, null, 'a retired key is never a valid override');
});

test('active-time duration: idle gaps capped, park freezes the clock', () => {
  const { ctx } = boot();
  ctx.startSession('A');
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

test('v7.2 migration: pre-v8 activeSession cursor remaps for the one-screen Form', () => {
  const mk = (cursor) => ({ schemaVersion:6, progressionEngineVersion:3, rotationIndex:0, nextSessionOverride:null,
    nextSessionSequence:1, pendingDeletes:[], anchorProgress:{}, legacy:{ promotions:{}, exerciseVariations:{}, promotionLog:[] }, log:[],
    activeSession:{ schemaVersion:7, type:'RP', startTime:1, activeMs:0, lastActiveAt:null, coreForkShown:false, cursor, phase:'view', setIdx:0, timerEnd:null, timerKind:null, records:{}, sessionNote:'', issues:[] } });
  // mid-Form (old cursor 3) -> restart Form at 0
  let s = boot({ seed: mk(3) }).ctx.getState();
  assert.equal(s.activeSession.cursor, 0);
  assert.equal(s.activeSession.schemaVersion, 8);
  assert.ok(s.activeSession.records['form-all'], 'form-all record injected');
  // past the Form (old cursor 9 = second station after 7 form + activation) -> shifts by 6
  s = boot({ seed: mk(9) }).ctx.getState();
  assert.equal(s.activeSession.cursor, 3);
});
