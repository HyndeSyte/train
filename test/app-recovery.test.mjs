// v7.3 recovery-layer acceptance harness (Gate 3). Same stubbed-DOM boot as
// app-elastic.test.mjs: extracts the inline app script from index.html and runs it in a
// Node vm context, then exercises the reviewed build notes: frozen sessions, every recovery
// block checked against the parked list, the daily arm check, symptom stops, PT's list
// outside the session slot, the replay-safe anchor reset, and the sync payload contract
// for every session type. Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { validatePayload, toNotionProperties } from '../lib/session-mapping.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function makeEl(){
  return { innerHTML:'', textContent:'', value:'', checked:false, style:{}, onclick:null,
    classList:{ _s:new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, toggle(c,f){ if(f===undefined) f=!this._s.has(c); f?this._s.add(c):this._s.delete(c); return f; } } };
}

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
  vm.runInContext(m[1] + '\n;globalThis.__AS = () => AS; globalThis.__PTS = () => PTS;', ctx);
  return { ctx, els, storage };
}

// An install that predates v7.3 (no recovery field): migrate() turns recovery mode ON.
function recoveryBoot(extra = {}){
  return boot({ seed: { schemaVersion:7, progressionEngineVersion:3, rotationIndex:0, nextSessionOverride:null,
    nextSessionSequence:0, pendingDeletes:[], activeSession:null, legacy:{ promotions:{}, exerciseVariations:{}, promotionLog:[] },
    anchorProgress:{}, log:[], ...extra } });
}

const AS_ = (c) => c.__AS();
// Values built inside the vm carry its realm's prototypes; compare plain JSON shapes.
const plain = (x) => JSON.parse(JSON.stringify(x));
const html = (c, id) => c.document.getElementById(id).innerHTML;
// Tap a showModal button by its label (showModal ids buttons 'mb-' + label without spaces).
function tap(ctx, label){
  const el = ctx.document.getElementById('mb-' + label.replace(/\s/g,''));
  assert.ok(el && typeof el.onclick === 'function', `button "${label}" is on screen`);
  el.onclick();
}

// Drive helpers (as in app-elastic.test.mjs) ---------------------------------------
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
  const flow = ctx.currentFlow();
  const st = flow[AS_(ctx).cursor];
  const n = ctx.setsFor(st);
  for(let i=0;i<n;i++){
    if(!AS_(ctx) || AS_(ctx).phase === 'coreFork') return;
    if(ctx.isDurationUnit(ctx.EXERCISE_LIBRARY[flow[AS_(ctx).cursor].exId].unit)){
      ctx.startDurationSet(); ctx.finishDurationEarly();
      if(AS_(ctx) && (AS_(ctx).phase === 'rest' || AS_(ctx).phase === 'restComplete')) ctx.endRestNow();
    } else {
      logSet(ctx, reps);
    }
  }
}
function completeGate(ctx, reps){
  let guard = 0;
  while(guard++ < 40){
    if(AS_(ctx).phase === 'coreFork') return;
    const st = ctx.currentFlow()[AS_(ctx).cursor];
    if(!st) return;
    if(st.kind !== 'exercise'){ ctx.advanceForm(); continue; }
    logWholeExercise(ctx, reps);
  }
}

// ---------------------------------------------------------------------------
test('migration: a pre-v7.3 install starts in recovery mode; a fresh install starts normal; a choice is never overwritten', () => {
  const { ctx } = recoveryBoot();
  const s = ctx.getState();
  assert.equal(s.recovery.on, true);
  assert.equal(s.recovery.cardioClear, false, 'effort cap holds until cardiology clears');
  assert.equal(s.armCheck, null);
  assert.equal(boot().ctx.getState().recovery.on, false, 'brand-new install: normal mode');
  const again = ctx.migrate(JSON.parse(JSON.stringify({ ...s, recovery:{ on:false, cardioClear:true, since:null, offAt:'2026-11-27T12:00:00.000Z' } })));
  assert.equal(again.recovery.on, false, 'an explicit off is kept');
  assert.equal(again.recovery.cardioClear, true);
});

test('Gate 3 (v8): recovery A/B/C use only the arm-safe swaps; leg load is his call; power waits for cardiology', () => {
  const { ctx } = recoveryBoot();
  // Parked on arms in recovery mode: hanging, full bodyweight on the arms, overhead or added
  // weight on arm work, flat palms, loaded carries; plus every normal entry a swap replaced.
  const PARKED = ['ring-pullup','ring-pushup','ring-chinup','ring-support','pike-pushup','para-pushup','db-press','hk-db-press',
    'hanging-knee-raise','ab-wheel','pushup','ring-face-pull','ring-row','ring-curl','jefferson-curl','split-squat','single-leg-rdl',
    'hinge-rdl','cossack-squat','glute-bridge','hollow-body','reverse-lunge','suitcase-carry','farmer-carry','side-plank','floor-getup'];
  const LOADED = /\bDB\b|dumbbell|weighted|\bband\b|hang/i;
  const gates = {};
  for(const type of ['A','B','C']){
    const flow = ctx.buildFlow(type, 'recovery');
    const ex = flow.filter(st=> st.kind === 'exercise');
    assert.ok(ex.length >= 4, `${type}: a full block list`);
    assert.equal(flow[0].uid, 'opener', `${type}: opens with the opener`);
    assert.ok(flow.some(st=> st.kind === 'activation'), `${type}: empty-handed shoulder prep`);
    ex.forEach(st=>{
      assert.ok(!PARKED.includes(st.exId), `${type}: ${st.exId} is parked in recovery mode`);
      assert.notEqual(st.progressionType, 'heavyAnchor', `${type}: recovery work never scores`);
      if(st.arms) assert.ok(!LOADED.test(ctx.getVariationName(st.exId)), `${type}: arm work "${ctx.getVariationName(st.exId)}" reads as loaded`);
    });
    assert.ok(!ex.some(st=> ['squat-jump','broad-jump','jump-rope','hill-repeats'].includes(st.exId)), `${type}: power waits for cardiology`);
    const uids = flow.map(st=> st.uid);
    assert.equal(new Set(uids).size, uids.length, `${type}: uids collision-free`);
    gates[type] = ex.filter(st=> st.gate).map(st=> st.exId + (st.arms ? '*' : ''));
  }
  assert.deepEqual(plain(gates), { A:['rec-split-squat','rec-ring-row*','rec-incline-pushup*'], B:['rec-sl-rdl','rec-wall-plus*','rec-pulldown*'], C:['rec-cossack','rec-incline-pushup*','rec-ring-row*'] });
  ['rec-split-squat','rec-sl-rdl','rec-cossack'].forEach(id=> assert.match(ctx.EXERCISE_LIBRARY[id].reference.cue, /at your side.*elbows? straight.*bodyweight/i, `${id}: load is his call, at the sides`));
  const act = ctx.templateFor('A', 'recovery').activation;
  assert.ok(act && /shoulder height or below/.test(JSON.stringify(act)));
  assert.ok(!/light DB|Band or/i.test(JSON.stringify(act)), 'no dumbbells or band in recovery activation');
  // Gate 4: cardiology clears hard efforts -> power returns in A and C
  ctx.setCardioClear(true);
  assert.ok(ctx.buildFlow('A', 'recovery').some(st=> st.exId === 'squat-jump'));
  assert.ok(ctx.buildFlow('C', 'recovery').some(st=> st.exId === 'broad-jump'));
  assert.deepEqual(plain(ctx.buildFlow('A').filter(st=> st.kind==='exercise').map(st=> st.exId)), ['squat-jump','split-squat','ring-pullup','para-pushup','suitcase-carry','ring-row']);
});

test('arm check: one tap at the day\'s first session (ring or PT); Skip is an answer; normal mode never asks', () => {
  const { ctx } = recoveryBoot();
  ctx.startSession('RP');
  assert.equal(AS_(ctx), null, 'the session waits for the arm check');
  tap(ctx, 'Worse');
  assert.ok(AS_(ctx), 'one tap starts the session');
  assert.equal(AS_(ctx).mode, 'recovery');
  assert.equal(AS_(ctx).armCheck, 'worse');
  ctx.discardCurrentSession();
  ctx.startPtSession();
  assert.ok(ctx.__PTS(), 'PT list opens without asking again the same day');
  assert.equal(ctx.__PTS().armCheck, 'worse');
  ctx.closePtSession();
  // next day: asked again; Skip records "no answer" and is not asked again that day
  const s = ctx.getState(); s.armCheck.date = '2000-01-01'; ctx.saveState(s);
  ctx.startPtSession();
  assert.equal(ctx.__PTS(), null, 'asked again on a new day');
  tap(ctx, 'Skip');
  assert.ok(ctx.__PTS());
  assert.equal(ctx.__PTS().armCheck, null);
  ctx.closePtSession();
  ctx.startPtSession();
  assert.ok(ctx.__PTS(), 'a skipped check is not asked again today');
  // normal mode
  const b = boot();
  b.ctx.startSession('RP');
  assert.ok(b.ctx.__AS(), 'normal mode starts directly');
  assert.equal(b.ctx.__AS().mode, 'normal');
  assert.equal(b.ctx.__AS().armCheck, null);
});

test('frozen session: a mode switch mid-session or while parked never re-shapes it; old in-flight sessions freeze as normal', () => {
  const { ctx } = recoveryBoot();
  ctx.recordArmCheck('same');
  ctx.startSession('RP');
  const uids = ctx.currentFlow().map(st=> st.uid);
  assert.ok(uids.includes('ex-rec-ring-row'));
  ctx.setRecoveryMode(false);
  assert.deepEqual(plain(ctx.currentFlow().map(st=> st.uid)), plain(uids), 'live session keeps its exercises');
  skipForm(ctx);
  ctx.parkSession();
  ctx.resumeSession();   // reloads the session from storage
  assert.deepEqual(plain(ctx.currentFlow().map(st=> st.uid)), plain(uids), 'parked session keeps its exercises');
  assert.equal(AS_(ctx).mode, 'recovery');
  completeGate(ctx, 10);
  assert.equal(AS_(ctx).phase, 'coreFork');
  ctx.finishAtFork();
  ctx.finalizeSession('completed');
  const e = ctx.getState().log.slice(-1)[0];
  assert.equal(e.mode, 'recovery', 'the entry records the mode it started in');
  assert.equal(e.coreComplete, true);
  assert.equal(e.armCheck, 'same');
  // a session in flight before v7.3 (no frozen flow) is frozen as a normal RP by migrate
  const legacyAS = { schemaVersion:8, type:'RP', startTime:1, activeMs:0, lastActiveAt:null, coreForkShown:false, cursor:2,
    phase:'view', setIdx:0, timerEnd:null, timerKind:null, records:{}, sessionNote:'', issues:[] };
  const b = recoveryBoot({ activeSession: legacyAS });
  const a = b.ctx.getState().activeSession;
  assert.equal(a.mode, 'normal');
  assert.ok(a.flow.some(st=> st.exId === 'ring-pullup'), 'still the normal RP it was');
  assert.equal(a.tpl.name, 'Heavy Rings: Pull');
});

test('recovery A/B/C session: gate completes and the rotation advances; nothing scores; scoreboard hidden; anchors restart at bodyweight, replay-safe', () => {
  const pre = [{ date:'2026-07-02', sessionType:'RPush', sessionStatus:'stopped', coreComplete:true, sessionId:'22222222-bbbb', sessionSequence:0,
    performed:[ { slotId:'RPush_anchor_ring-pushup', exId:'ring-pushup', role:'anchor', progressionType:'heavyAnchor', reps:[8,8,8,8] } ] }];
  const preAnchors = { 'RPush_anchor_ring-pushup': { exId:'ring-pushup', label:'Heavy Push', lastRawQualityReps:32, creditedQualityReps:null,
    previousCreditedQualityReps:32, creditCapped:false, externalLoad:5, loadUnit:'lb', variationId:null, lastDate:'2026-07-02', steppedUp:true } };
  const { ctx } = recoveryBoot({ log: pre, nextSessionSequence: 1, anchorProgress: preAnchors });
  ctx.recordArmCheck('better');
  ctx.startSession('A');
  completeGate(ctx, 10);
  assert.equal(AS_(ctx).phase, 'coreFork', 'core = opener, prep, legs + arm gates');
  ctx.finishAtFork();
  ctx.finalizeSession('completed');
  let s = ctx.getState();
  const e = s.log.slice(-1)[0];
  assert.equal(e.mode, 'recovery');
  assert.equal(e.sessionStatus, 'completed');
  assert.equal(s.rotationIndex, 1, 'advanced from logged A');
  assert.equal(e.anchorSnapshot, undefined, 'no scoreboard snapshot for recovery work');
  for(const slot of ['A_anchor_ring-pullup','C_anchor_ring-pushup','RPush_anchor_ring-pushup']){
    assert.equal(s.anchorProgress[slot].externalLoad, 0, `${slot}: bodyweight`);
    assert.equal(s.anchorProgress[slot].creditedQualityReps, null, `${slot}: fresh baseline pending`);
  }
  ctx.renderHome();
  assert.ok(!html(ctx, 'home-content').includes('anchor-card'), 'scoreboard hidden in recovery mode');
  ctx.setRecoveryMode(false);
  ctx.startSession('C');
  completeGate(ctx, 5);   // cossack, ring push-up 5/5 = 10 baseline, chin-up
  if(AS_(ctx).phase === 'coreFork') ctx.finishAtFork();
  ctx.finalizeSession('completed');
  s = ctx.getState();
  let push = s.anchorProgress['C_anchor_ring-pushup'];
  assert.equal(push.externalLoad, 0, 'restarts at bodyweight');
  assert.equal(push.creditedQualityReps, 10, '5 x 2 = the new baseline');
  const full = JSON.parse(JSON.stringify(s));
  ctx.rebuildAnchorProgress(full);
  assert.equal(full.anchorProgress['C_anchor_ring-pushup'].externalLoad, 0, 'the reset survives the replay');
  assert.equal(full.anchorProgress['C_anchor_ring-pushup'].creditedQualityReps, 10);
  ctx.deleteLogEntry(0);
  push = ctx.getState().anchorProgress['C_anchor_ring-pushup'];
  assert.equal(push.externalLoad, 0);
  assert.equal(push.creditedQualityReps, 10);
  ctx.renderHome();
  const h = html(ctx, 'home-content');
  assert.ok(h.includes('anchor-card'), 'scoreboard returns with normal mode');
  assert.doesNotMatch(h, /\(v7\)/, 'v7 slots never show on Home');
});

test('symptom stop (v8): first crossing stops the exercise and its gate counts; End arm work finishes the legs; Core never counts before the legs', () => {
  const { ctx } = recoveryBoot();
  ctx.recordArmCheck('same');
  ctx.startSession('A');
  skipForm(ctx);
  ctx.renderStation();
  assert.match(html(ctx, 'flow-foot'), /Symptom stop/, 'button on recovery stations');
  // End arm work on the very first (leg) exercise: Core must still wait for the legs
  ctx.openSymptomStop();
  tap(ctx, 'End arm work, finish the legs');
  assert.equal(AS_(ctx).armWorkEnded, true);
  assert.equal(ctx.liveCoreComplete(), false, 'never instantly complete');
  logWholeExercise(ctx, 10);   // the legs
  assert.equal(ctx.liveCoreComplete(), true, 'legs done -> Core counts');
  completeGate(ctx, 8);
  if(AS_(ctx).phase === 'coreFork') ctx.finishAtFork();
  ctx.finalizeSession('completed');
  let s = ctx.getState();
  let e = s.log.slice(-1)[0];
  assert.equal(e.sessionStatus, 'completed');
  assert.equal(e.coreComplete, true);
  assert.equal(e.symptomStop, true);
  assert.equal(e.performed.find(p=> p.exId === 'rec-ring-row').skipped, true, 'arm work passed over');
  assert.equal(s.rotationIndex, 1, 'a bad day never stalls the rotation');
  // a single crossing on an arm gate: that exercise stops and its gate still counts
  ctx.startSession('B');
  skipForm(ctx);
  logWholeExercise(ctx, 8);   // hinge
  logSet(ctx, 9);             // wall push-up plus, first set
  ctx.openSymptomStop();
  tap(ctx, 'Stop this exercise');
  logWholeExercise(ctx, 8);   // pulldown
  assert.equal(AS_(ctx).phase, 'coreFork', 'stopped gate still counts: core complete');
  ctx.finishAtFork();
  ctx.finalizeSession('completed');
  e = ctx.getState().log.slice(-1)[0];
  assert.deepEqual(plain(e.symptomStops), ['rec-wall-plus']);
  assert.deepEqual(plain(e.performed.find(p=> p.exId === 'rec-wall-plus').reps), [9,0]);
  // next time: one rung easier
  ctx.startSession('B');
  skipForm(ctx);
  logWholeExercise(ctx, 8);
  ctx.renderStation();
  assert.match(html(ctx, 'flow-body'), /one rung easier/);
  const b = boot();
  b.ctx.startSession('A'); skipForm(b.ctx); b.ctx.renderStation();
  assert.doesNotMatch(b.ctx.document.getElementById('flow-foot').innerHTML, /Symptom stop/);
});

test('Legs only today (v8): arm work passed over and marked omitted; Core counts on the legs; no symptom stop; no anchor credit; labelled', () => {
  const { ctx } = recoveryBoot();
  ctx.recordArmCheck('worse');
  ctx.renderHome();
  assert.match(html(ctx, 'home-content'), /startSession\('A',\{legsOnly:true\}\)/, 'Legs only today on Home');
  ctx.startSession('A', { legsOnly:true });
  assert.equal(AS_(ctx).legsOnly, true);
  assert.equal(ctx.liveCoreComplete(), false);
  completeGate(ctx, 10);
  if(AS_(ctx).phase === 'coreFork') ctx.finishAtFork();
  ctx.finalizeSession('completed');
  const s = ctx.getState();
  const e = s.log.slice(-1)[0];
  assert.equal(e.legsOnly, true);
  assert.equal(e.coreComplete, true);
  assert.equal(e.symptomStop, undefined, 'legs only is a choice, not a symptom stop');
  const row = e.performed.find(p=> p.exId === 'rec-ring-row');
  assert.equal(row.skipped, true);
  assert.equal(row.omitted, 'legsOnly');
  assert.equal(s.rotationIndex, 1);
  const wire = JSON.parse(JSON.stringify(ctx.buildSyncPayload(e)));
  assert.match(wire.sessionNote, /^Legs only today/);
  ctx.renderHistory();
  assert.match(html(ctx, 'history-content'), /Legs only/);
  // normal mode: a legs-only A never earns anchor credit
  const n = boot();
  n.ctx.startSession('A', { legsOnly:true });
  completeGate(n.ctx, 10);
  if(AS_(n.ctx).phase === 'coreFork') n.ctx.finishAtFork();
  n.ctx.finalizeSession('completed');
  assert.equal(n.ctx.getState().anchorProgress['A_anchor_ring-pullup'], undefined);
});

test('symptom stop, leg day: finish the legs; remaining arm work is passed over; the session counts', () => {
  const { ctx } = recoveryBoot();
  ctx.recordArmCheck('worse');
  ctx.startSession('LP');
  skipForm(ctx);
  ctx.renderStation();
  assert.match(html(ctx, 'flow-body'), /no progression today/, 'worse day: hold, no progression');
  ctx.openSymptomStop();
  tap(ctx, 'End arm work, finish the legs');
  assert.equal(AS_(ctx).armWorkEnded, true);
  assert.equal(ctx.currentFlow()[AS_(ctx).cursor].exId, 'rec-glute-bridge', 'the legs carry on where they were');
  completeGate(ctx, 10);
  assert.equal(AS_(ctx).phase, 'coreFork');
  ctx.keepGoingFromFork();
  logWholeExercise(ctx, 8);   // single-leg RDL; the dead bug (arm work) is then passed over
  assert.equal(AS_(ctx).cursor, ctx.currentFlow().length);
  ctx.finalizeSession('completed');
  const e = ctx.getState().log.slice(-1)[0];
  assert.equal(e.sessionStatus, 'completed');
  assert.equal(e.coreComplete, true);
  assert.equal(e.armCheck, 'worse');
  assert.equal(e.performed.find(p=> p.exId === 'rec-dead-bug').skipped, true, 'dead bug passed over');
  assert.equal(e.performed.find(p=> p.exId === 'rec-split-squat').skipped, undefined, 'legs done');
});

test("PT's list: runs outside the slot while a ring session is parked; never touches rotation, override or the park", () => {
  const { ctx } = recoveryBoot({ nextSessionOverride: 'B' });
  ctx.recordArmCheck('same');
  ctx.startSession('B');
  skipForm(ctx);
  logSet(ctx, 10);
  ctx.parkSession();
  let s = ctx.getState();
  const parked = JSON.stringify(s.activeSession);
  ctx.renderHome();
  assert.match(html(ctx, 'home-content'), /Parked/);
  assert.match(html(ctx, 'home-content'), /startPtSession\(\)/, 'PT list startable while a ring session is parked');
  ctx.startPtSession();
  assert.ok(ctx.__PTS());
  ctx.ptOpen(0); ctx.ptItemDone('done');
  ctx.ptBackToList();
  ctx.document.getElementById('pt-note').value = 'glides tingly at rep 8';
  ctx.ptOpen(1);   // opening an item keeps the typed note
  ctx.ptItemDone('stopped');
  ctx.ptBackToList();
  assert.equal(ctx.__PTS().note, 'glides tingly at rep 8');
  ctx.finishPtSession();
  s = ctx.getState();
  const e = s.log.slice(-1)[0];
  assert.equal(e.sessionType, 'PT');
  assert.equal(e.mode, 'recovery');
  assert.equal(e.ptList, true);
  assert.equal(e.coreComplete, true);
  assert.equal(e.sessionStatus, 'stopped', 'one item stopped for symptoms: the record says so');
  assert.equal(e.armCheck, 'same');
  assert.equal(e.notes, 'glides tingly at rep 8');
  assert.deepEqual(plain(e.ptItems.map(i=> i.name)), plain(ctx.PT_LIST.items.map(i=> i.name)));
  assert.equal(e.ptItems[0].status, 'done');
  assert.equal(e.ptItems[1].status, 'stopped');
  assert.equal(e.ptItems[2].status, 'not done');
  assert.equal(e.ptItems[0].dose, ctx.ptDoseLine(ctx.PT_LIST.items[0]));
  assert.equal(JSON.stringify(s.activeSession), parked, 'the parked session is untouched');
  assert.equal(s.rotationIndex, 0);
  assert.equal(s.nextSessionOverride, 'B');
  assert.equal(ctx.__PTS(), null);
  ctx.renderHome();
  assert.match(html(ctx, 'home-content'), /Done today/);
  // its payload validates against the live mapping contract
  const wire = JSON.parse(JSON.stringify(ctx.buildSyncPayload(e)));
  assert.equal(validatePayload(wire).ok, true);
  const p = toNotionProperties(wire, '2026-10-15T12:00:00.000Z');
  assert.equal(p['Session Type'].select.name, 'PT');
  assert.equal(p['PT List'].checkbox, true);
  assert.equal(p['Mode'].select.name, 'Recovery');
  assert.equal(p['Arm Check'].select.name, 'Same');
  assert.equal(wire.detail.exercises[0].role, 'pt');
  assert.equal(wire.detail.exercises[0].reps, ctx.ptDoseLine(ctx.PT_LIST.items[0]));
  assert.equal(wire.detail.exercises[1].issue, 'stopped for symptoms');
  assert.equal(wire.detail.exercises[0].role, 'pt');
});

test('sync payload contract: every session type in every mode validates and maps Mode / Arm Check / PT List', () => {
  const { ctx } = recoveryBoot();
  const mk = (o) => ({ sessionId:'s'.repeat(12), sessionSequence:1, date:'2026-10-15', completedAt:'2026-10-15T12:00:00.000Z',
    sessionStatus:'completed', coreComplete:true, performed:[], exerciseMeta:{}, issues:[], ...o });
  const cases = [
    ...['A','B','C','RP','LP','RPush','LS','RPr','MVS'].map(t=> ({ e: mk({ sessionType:t, mode:'normal' }), mode:'Normal', arm:undefined, pt:undefined })),
    ...['A','B','C','RP','LP','RPush','LS','RPr'].map(t=> ({ e: mk({ sessionType:t, mode:'recovery', armCheck:'worse' }), mode:'Recovery', arm:'Worse', pt:undefined })),
    { e: mk({ sessionType:'EN', coreComplete:null, engineKind:'Walk', duration:30 }), mode:undefined, arm:undefined, pt:undefined },
    { e: mk({ sessionType:'PT', mode:'recovery', ptList:true, armCheck:'better', ptItems:[{ name:'Supine chin tuck', dose:'3 x 10' }] }), mode:'Recovery', arm:'Better', pt:true },
    { e: mk({ sessionType:'RP' }), mode:undefined, arm:undefined, pt:undefined }   // history from before v7.3
  ];
  for(const c of cases){
    const wire = JSON.parse(JSON.stringify(ctx.buildSyncPayload(c.e)));
    const v = validatePayload(wire);
    assert.equal(v.ok, true, `${c.e.sessionType}/${c.e.mode}: ${v.error}`);
    const p = toNotionProperties(wire, '2026-10-15T12:00:00.000Z');
    assert.equal(p['Mode'] ? p['Mode'].select.name : undefined, c.mode, `${c.e.sessionType}/${c.e.mode}: Mode`);
    assert.equal(p['Arm Check'] ? p['Arm Check'].select.name : undefined, c.arm, `${c.e.sessionType}/${c.e.mode}: Arm Check`);
    assert.equal(p['PT List'] ? p['PT List'].checkbox : undefined, c.pt, `${c.e.sessionType}/${c.e.mode}: PT List`);
  }
});

test('Home and Settings: PT list takes the Floor slot; Legs only today; rules card; switches work', () => {
  const { ctx } = recoveryBoot();
  ctx.renderHome();
  let h = html(ctx, 'home-content');
  assert.match(h, /A · Squat \+ Pull \(recovery\)/);
  assert.doesNotMatch(h, /startSession\('MVS'\)/, 'Floor link gone: PT list takes its place');
  assert.match(h, /startPtSession\(\)/);
  assert.match(h, /Legs only today/);
  assert.match(h, /Recovery rules/);
  assert.match(h, /This week/);
  assert.ok(h.indexOf('Start Today') < h.indexOf('This week'), 'Start stays the dominant action, measures below');
  ctx.renderSettings();
  assert.match(html(ctx, 'settings-content'), /Cardiology cleared hard efforts/);
  assert.match(html(ctx, 'settings-content'), /Record markers/);
  ctx.toggleRecoveryMode();
  tap(ctx, 'Turn off');
  assert.equal(ctx.getState().recovery.on, false);
  ctx.renderHome();
  h = html(ctx, 'home-content');
  assert.match(h, /startSession\('MVS'\)/, 'Floor day back in normal mode');
  assert.doesNotMatch(h, /startPtSession\(\)/);
  assert.match(h, /A · Squat \+ Pull/);
  assert.match(h, /90-second opener/);
  ctx.toggleRecoveryMode();
  tap(ctx, 'Turn on');
  assert.equal(ctx.getState().recovery.on, true);
  assert.ok(ctx.getState().recovery.since, 'records when it was turned on');
});

test('Form keeps its seven steps with the two permanent neck edits; leave sheet carries the cardiac signs until cleared', () => {
  const { ctx } = recoveryBoot();
  assert.equal(ctx.FORM.screens.length, 7);
  const neck = ctx.FORM.screens[0].movements.find(m=> m.name === 'Neck + Scapular Setting').detail;
  assert.match(neck, /chin tucks/);
  assert.doesNotMatch(neck, /circles/);
  const bow = ctx.FORM.screens[6].movements.find(m=> /Bow/.test(m.name)).detail;
  assert.doesNotMatch(bow, /head heavy/);
  assert.match(bow, /head following the spine/);
  ctx.recordArmCheck('same');
  ctx.startSession('RP');
  ctx.renderStation();
  assert.match(html(ctx, 'flow-body'), /flat palms/, 'Form card carries the Arms up and Hands rules');
  ctx.confirmStopSession();
  assert.match(ctx.document.getElementById('modal-body').textContent, /call cardiology/);
  ctx.hideModal();
  ctx.setCardioClear(true);
  ctx.confirmStopSession();
  assert.doesNotMatch(ctx.document.getElementById('modal-body').textContent, /cardiology/);
  skipForm(ctx);
  ctx.renderStation();
  assert.doesNotMatch(html(ctx, 'flow-body'), /two reps short/, 'cap lifted after Gate 4');
});

// ---- Review fixes (independent review before ship, 2026-10-15) ----------------------
test('a session started before recovery mode is flagged on Home: Discard leads, Resume sits behind a confirm', () => {
  const legacyAS = { schemaVersion:8, type:'RP', startTime:1, activeMs:0, lastActiveAt:null, coreForkShown:false, cursor:2,
    phase:'view', setIdx:0, timerEnd:null, timerKind:null, records:{}, sessionNote:'', issues:[] };
  const { ctx } = recoveryBoot({ activeSession: legacyAS });
  ctx.renderHome();
  const h = html(ctx, 'home-content');
  assert.match(h, /started before recovery mode/);
  assert.match(h, /discardActiveSession\(\)/);
  assert.match(h, /startPtSession\(\)/, 'PT list still available');
  ctx.confirmResumePreRecovery();
  tap(ctx, 'Resume');
  assert.equal(AS_(ctx).mode, 'normal', 'resuming keeps it the normal session it was');
  assert.ok(ctx.currentFlow().some(st=> st.exId === 'ring-pullup'));
});

test('cardiology cap belongs to cardiology: it outlives recovery mode until cleared (jump rope, cap line, warning signs)', () => {
  const { ctx } = recoveryBoot();
  ctx.setRecoveryMode(false);
  assert.equal(ctx.cardioCapOn(ctx.getState()), true);
  assert.ok(!ctx.buildFlow('LS').some(st=> st.exId === 'jump-rope'), 'normal LS: no jump rope under the cap');
  assert.ok(!ctx.buildFlow('LP').some(st=> st.exId === 'jump-rope'), 'normal LP: no jump rope under the cap');
  assert.ok(ctx.buildFlow('LP').some(st=> st.exId === 'single-leg-rdl'), 'the rest of the block stays');
  ctx.renderHome();
  assert.match(html(ctx, 'home-content'), /Until cardiology clears/);
  ctx.renderSettings();
  assert.match(html(ctx, 'settings-content'), /Cardiology cleared hard efforts/, 'the switch stays reachable');
  ctx.startSession('RP');
  assert.equal(AS_(ctx).mode, 'normal');
  skipForm(ctx); ctx.renderStation();
  assert.match(html(ctx, 'flow-body'), /Until cardiology clears: two reps short of failure/);
  ctx.confirmStopSession();
  assert.match(ctx.document.getElementById('modal-body').textContent, /call cardiology/);
  ctx.hideModal();
  ctx.setCardioClear(true);
  assert.ok(ctx.buildFlow('LS').some(st=> st.exId === 'jump-rope'), 'cleared: jump rope back');
  // a fresh install never had the cap
  const f = boot();
  assert.equal(f.ctx.cardioCapOn(f.ctx.getState()), false);
  assert.ok(f.ctx.buildFlow('LS').some(st=> st.exId === 'jump-rope'));
});

test('cardiology set back to not-cleared mid-session: jump rope in a frozen session is passed over', () => {
  const { ctx } = recoveryBoot();
  ctx.recordArmCheck('same');
  ctx.setCardioClear(true);
  ctx.startSession('LP');
  assert.ok(ctx.currentFlow().some(st=> st.exId === 'jump-rope'), 'built while cleared');
  ctx.setCardioClear(false);
  completeGate(ctx, 10);
  if(AS_(ctx).phase === 'coreFork') ctx.keepGoingFromFork();
  logWholeExercise(ctx, 8);       // single-leg RDL; jump rope is next and gets passed over
  const st = ctx.currentFlow()[AS_(ctx).cursor];
  assert.equal(st.exId, 'rec-dead-bug', 'jump rope skipped, dead bug next');
  logWholeExercise(ctx, 8);
  ctx.finalizeSession('completed');
  const e = ctx.getState().log.slice(-1)[0];
  assert.equal(e.performed.find(p=> p.exId === 'jump-rope').skipped, true);
});

test('turning recovery off resets the anchors even with no recovery entry logged, and a later replay keeps it', () => {
  const pre = [
    { date:'2026-07-02', sessionType:'RPush', sessionStatus:'stopped', coreComplete:true, sessionId:'22222222-bbbb', sessionSequence:0,
      performed:[ { slotId:'RPush_anchor_ring-pushup', exId:'ring-pushup', role:'anchor', progressionType:'heavyAnchor', reps:[8,8,8,8] } ] },
    { date:'2026-07-04', sessionType:'LP', sessionStatus:'completed', coreComplete:true, sessionId:'33333333-cccc', sessionSequence:1,
      performed:[ { slotId:'LP_anchor_split-squat', exId:'split-squat', role:'anchor', progressionType:'loose', reps:[8,8,8] } ] } ];
  const preAnchors = { 'RPush_anchor_ring-pushup': { exId:'ring-pushup', label:'Heavy Push', lastRawQualityReps:32, creditedQualityReps:null,
    previousCreditedQualityReps:32, creditCapped:false, externalLoad:5, loadUnit:'lb', variationId:null, lastDate:'2026-07-02', steppedUp:true } };
  const { ctx } = recoveryBoot({ log: pre, nextSessionSequence: 2, anchorProgress: preAnchors });
  ctx.setRecoveryMode(false);
  let s = ctx.getState();
  assert.equal(s.anchorProgress['RPush_anchor_ring-pushup'].externalLoad, 0);
  assert.equal(s.anchorProgress['RPush_anchor_ring-pushup'].creditedQualityReps, null);
  assert.equal(s.recovery.resetSeq, 2);
  ctx.deleteLogEntry(1);   // an unrelated delete replays the whole log
  s = ctx.getState();
  assert.equal(s.anchorProgress['RPush_anchor_ring-pushup'].externalLoad, 0, 'the turn-off reset survives the replay');
  // and a post-recovery session still builds on bodyweight through a replay
  ctx.startSession('RPush'); skipForm(ctx); logWholeExercise(ctx, 5);
  if(AS_(ctx).phase === 'coreFork') ctx.finishAtFork();
  ctx.finalizeSession('completed');
  const full = JSON.parse(JSON.stringify(ctx.getState()));
  ctx.rebuildAnchorProgress(full);
  assert.equal(full.anchorProgress['RPush_anchor_ring-pushup'].externalLoad, 0);
  assert.equal(full.anchorProgress['RPush_anchor_ring-pushup'].creditedQualityReps, 20);
});

test('arm check answer is used even if storage cannot persist it (no question loop on resume)', () => {
  const { ctx, storage } = recoveryBoot();
  ctx.recordArmCheck('same');
  ctx.startSession('RP');
  skipForm(ctx);
  ctx.parkSession();
  const s = ctx.getState(); s.armCheck.date = '2000-01-01'; ctx.saveState(s);
  const realSet = ctx.localStorage.setItem;
  ctx.localStorage.setItem = () => { throw new Error('quota'); };   // writes fail from here on
  ctx.resumeSession();
  tap(ctx, 'Better');
  assert.ok(AS_(ctx), 'resumed after one tap');
  assert.equal(AS_(ctx).armCheck, 'better');
  ctx.localStorage.setItem = realSet;
  assert.ok(storage.size >= 1);
});

test("PT's list is once a day: reopening it is view-only and never logs a second entry; a list belongs to the day it started", () => {
  const { ctx } = recoveryBoot();
  ctx.recordArmCheck('same');
  ctx.startPtSession();
  ctx.finishPtSession();   // nothing done yet: Finish logs nothing
  assert.equal(ctx.getState().log.length, 0);
  assert.equal(ctx.document.getElementById('modal-title').textContent, 'Nothing done yet');
  ctx.ptOpen(1); ctx.ptItemDone('done');
  ctx.finishPtSession();
  const n = ctx.getState().log.length;
  assert.equal(n, 1);
  ctx.startPtSession();
  assert.equal(ctx.__PTS().viewOnly, true);
  ctx.renderPtScreen();
  assert.match(html(ctx, 'pt-content'), /Logged today/);
  ctx.finishPtSession();
  assert.equal(ctx.getState().log.length, n, 'no second entry');
  // started yesterday (local), finished today: it counts for yesterday
  const b = recoveryBoot({ log: [ { date:'2026-10-15', sessionType:'PT', mode:'recovery', ptList:true, coreComplete:true, sessionStatus:'completed',
    sessionId:'pt-yesterday-0001', sessionSequence:0, startedAt: new Date(Date.now() - 24*3600*1000).toISOString(), completedAt: new Date().toISOString() } ], nextSessionSequence: 1 });
  assert.equal(b.ctx.ptDoneToday(b.ctx.getState()), false);
});

test('leg-day symptom stop: no rest or "next" label pointing at passed-over arm work', () => {
  const { ctx } = recoveryBoot();
  ctx.recordArmCheck('same');
  ctx.startSession('LP');
  skipForm(ctx);
  ctx.openSymptomStop();
  tap(ctx, 'End arm work, finish the legs');
  completeGate(ctx, 10);
  ctx.keepGoingFromFork();
  // single-leg RDL is the last live item now
  assert.equal(ctx.nextFlowItemLabel(), 'Finish');
  ctx.document.getElementById('rep-input').value = '8'; ctx.logRepSet();
  assert.equal(AS_(ctx).phase, 'rest');
  assert.doesNotMatch(ctx.restNextLabel(ctx.currentFlow()[AS_(ctx).cursor], ctx.EXERCISE_LIBRARY['rec-sl-rdl']), /Dead Bug/);
  ctx.endRestNow();
  ctx.document.getElementById('rep-input').value = '8'; ctx.logRepSet(); ctx.endRestNow();
  ctx.document.getElementById('rep-input').value = '8'; ctx.logRepSet();
  assert.notEqual(AS_(ctx).phase, 'rest', 'no rest before passed-over arm work');
  assert.equal(AS_(ctx).cursor, ctx.currentFlow().length);
});

test('a recovery session resumed on a new day takes that day\'s arm check and logs it', () => {
  const { ctx } = recoveryBoot();
  ctx.recordArmCheck('same');
  ctx.startSession('RP');
  skipForm(ctx);
  ctx.parkSession();
  const s = ctx.getState(); s.armCheck.date = '2000-01-01'; ctx.saveState(s);
  ctx.resumeSession();
  assert.equal(AS_(ctx), null, 'waits for the new day\'s check');
  tap(ctx, 'Worse');
  assert.ok(AS_(ctx));
  assert.equal(AS_(ctx).armCheck, 'worse');
  completeGate(ctx, 9);
  if(AS_(ctx).phase === 'coreFork') ctx.finishAtFork();
  ctx.finalizeSession('completed');
  assert.equal(ctx.getState().log.slice(-1)[0].armCheck, 'worse');
});

test('every recovery ring day opens with the empty-handed activation, RPr included', () => {
  const { ctx } = recoveryBoot();
  for(const t of ['RP','RPush','RPr']) assert.ok(ctx.buildFlow(t, 'recovery').some(st=> st.kind === 'activation'), `${t} has activation`);
  for(const t of ['LP','LS']) assert.ok(!ctx.buildFlow(t, 'recovery').some(st=> st.kind === 'activation'), `${t}: legs, no shoulder prep`);
});
