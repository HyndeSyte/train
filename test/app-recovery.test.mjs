// v8.1.0: recovery mode and the cardiology effort cap are retired. This file proves every
// install now behaves as a normal install, and that old data still works: legacy history
// entries (PT's list, recovery-mode sessions, arm checks), the replay-safe anchor reset, the
// sync payload for every entry shape, and a session frozen under the old mode. Same
// stubbed-DOM boot as app-elastic.test.mjs. Run: node --test test/
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
  vm.runInContext(m[1] + '\n;globalThis.__AS = () => AS;', ctx);
  return { ctx, els, storage };
}

// An older install seed (schema 7). Pass `recovery` to carry the retired switch state.
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

const OLD_RECOVERY = { on:true, cardioClear:false, since:'2026-10-15T12:00:00.000Z', offAt:null };

test('an install with recovery.on true starts a NORMAL A session: power block, full template, no arm check, no recovery mode', () => {
  const { ctx } = recoveryBoot({ recovery: OLD_RECOVERY });
  ctx.startSession('A');
  assert.ok(AS_(ctx), 'session started with no arm-check question');
  assert.equal(AS_(ctx).mode, 'normal');
  assert.equal(AS_(ctx).armCheck, undefined);
  const uids = ctx.currentFlow().map(st=> st.uid);
  assert.ok(uids.includes('ex-squat-jump'), 'power block is there');
  assert.ok(uids.includes('ex-suitcase-carry') && uids.includes('ex-ring-pullup'));
  assert.ok(!uids.some(u=> u.startsWith('ex-rec-')), 'no recovery swaps');
  assert.equal(AS_(ctx).tpl.name, 'A · Squat + Pull');
  ctx.parkSession();
  ctx.renderHome();
  const h = html(ctx, 'home-content');
  assert.doesNotMatch(h, /recovery|cardiology|PT.s list|Recovery rules/i);
  ctx.resumeSession();
  skipForm(ctx);
  completeGate(ctx, 10);
  if(AS_(ctx).phase === 'coreFork') ctx.finishAtFork();
  ctx.finalizeSession('completed');
  const e = ctx.getState().log.slice(-1)[0];
  assert.equal(e.mode, 'normal');
  assert.equal(e.armCheck, undefined);
  assert.equal(ctx.getState().rotationIndex, 1);
  assert.ok(ctx.getState().recovery, 'the legacy state object is tolerated, not deleted');
  assert.equal(ctx.getState().anchorProgress['A_anchor_ring-pullup'].lastRawQualityReps, 20, 'a normal session scores');
  ctx.renderHome();
  assert.match(html(ctx, 'home-content'), /anchor-card/, 'scoreboard is shown');
});

test('Home offers Floor and Legs only today for everyone; the scoreboard shows; Settings has no recovery or cardiology rows', () => {
  for(const extra of [{ recovery: OLD_RECOVERY }, { recovery: { on:false, cardioClear:false, since:null, offAt:null } }, {}]){
    const { ctx } = recoveryBoot(extra);
    ctx.renderHome();
    const h = html(ctx, 'home-content');
    assert.match(h, /startSession\('A',\{legsOnly:true\}\)/, 'Legs only today on Home');
    assert.match(h, /startSession\('MVS'\)/, 'Floor day link');
    assert.doesNotMatch(h, /Until cardiology|two reps short/i);
    ctx.renderSettings();
    assert.doesNotMatch(html(ctx, 'settings-content'), /Recovery mode|Cardiology|toggleRecoveryMode|toggleCardioClear/i);
    assert.equal(typeof ctx.toggleRecoveryMode, 'undefined');
    assert.equal(typeof ctx.setCardioClear, 'undefined');
    assert.equal(typeof ctx.startPtSession, 'undefined');
    ctx.renderReference();
    assert.doesNotMatch(html(ctx, 'reference-content'), /PT.s list|Recovery swaps/);
  }
});

test('templateFor never filters conditioning, whatever the legacy state says', () => {
  const { ctx } = recoveryBoot({ recovery: OLD_RECOVERY });
  const keys = Object.keys(ctx.SESSION_TEMPLATES);
  for(const k of keys){
    assert.equal(ctx.templateFor(k, 'recovery', { recovery: OLD_RECOVERY }), ctx.SESSION_TEMPLATES[k], `${k}: the template object itself`);
    assert.equal(ctx.templateFor(k), ctx.SESSION_TEMPLATES[k]);
  }
  const ids = (t)=> ctx.SESSION_TEMPLATES[t].blocks.reduce((a,b)=> a.concat(b.exercises), []);
  assert.ok(ids('A').includes('squat-jump') && ids('C').includes('broad-jump') && ids('C').includes('hill-repeats'));
  assert.ok(ids('LP').includes('jump-rope') && ids('LS').includes('jump-rope'));
  assert.equal(typeof ctx.isRecoveryOn, 'undefined');
  assert.equal(typeof ctx.cardioCapOn, 'undefined');
  assert.equal(typeof ctx.sessionModeFor, 'undefined');
  for(const t of ['A','C']){
    const f = ctx.buildFlow(t).map(st=> st.exId);
    assert.ok(f.includes(t === 'A' ? 'squat-jump' : 'broad-jump'));
  }
  assert.equal(ctx.window.RECOVERY_TEMPLATES, undefined);
  assert.equal(ctx.window.PT_LIST, undefined);
  assert.ok(ctx.EXERCISE_LIBRARY['rec-ring-row'], 'recovery exercises stay in the library so history can name them');
  assert.match(readFileSync(join(root,'index.html'),'utf8'), /key:'broadjump', label:'Broad jump', unit:'in', hint:'best of 3' \}/);
});

test('legacy history still renders: a PT entry, a recovery-mode RP entry with an arm check, and entryName', () => {
  const log = [
    { date:'2026-10-20', sessionType:'RP', mode:'recovery', armCheck:'worse', sessionStatus:'completed', coreComplete:true, sessionId:'rec-rp-0001', sessionSequence:0,
      duration:22, exercises:{ 'rec-ring-row':[8,8,8] }, performed:[ { slotId:'RP_builder_rec-ring-row', exId:'rec-ring-row', role:'builder', reps:[8,8,8] } ] },
    { date:'2026-10-21', sessionType:'PT', mode:'recovery', ptList:true, armCheck:'better', sessionStatus:'completed', coreComplete:true, sessionId:'pt-0000001', sessionSequence:1,
      duration:9, exercises:{}, performed:[], ptItems:[ { name:'Supine chin tuck', dose:'1 x 10, 5 s hold each', block:'pt', status:'done' } ] },
    { date:'2026-10-22', sessionType:'A', mode:'recovery', armCheck:'same', sessionStatus:'completed', coreComplete:true, sessionId:'rec-a-0001', sessionSequence:2,
      duration:20, exercises:{ 'rec-split-squat':[10,10] }, performed:[] },
    { date:'2026-10-23', sessionType:'LP', mode:'recovery', sessionStatus:'completed', coreComplete:true, sessionId:'rec-lp-0001', sessionSequence:3, duration:20, exercises:{}, performed:[] },
    { date:'2026-10-24', sessionType:'RPr', mode:'recovery', sessionStatus:'completed', coreComplete:true, sessionId:'rec-rpr-001', sessionSequence:4, duration:20, exercises:{}, performed:[] },
    { date:'2026-10-25', sessionType:'ZZ', mode:'recovery', sessionStatus:'completed', coreComplete:true, sessionId:'rec-zz-0001', sessionSequence:5, duration:20, exercises:{}, performed:[] }
  ];
  const { ctx } = recoveryBoot({ recovery: OLD_RECOVERY, log, nextSessionSequence: 6 });
  assert.equal(ctx.entryName(log[0]), 'Pull (recovery)');
  assert.equal(ctx.entryName(log[1]), 'PT’s list');
  assert.equal(ctx.entryName(log[2]), 'A · Squat + Pull (recovery)');
  assert.equal(ctx.entryName(log[3]), 'Lower: Posterior (recovery)');
  assert.equal(ctx.entryName(log[4]), 'Ring Practice (recovery)');
  assert.equal(ctx.entryName(log[5]), 'Recovery session', 'unknown recovery type falls back to a generic name');
  assert.equal(ctx.entryName({ sessionType:'EN' }), 'Engine');
  assert.equal(ctx.entryName({ sessionType:'B', mode:'normal' }), 'B · Hinge + Press');
  ctx.renderHistory();
  const h = html(ctx, 'history-content');
  assert.match(h, /Pull \(recovery\)/);
  assert.match(h, /PT’s list/);
  assert.match(h, /Supine chin tuck/);
  assert.match(h, /Arm check: <span>worse<\/span>/);
  assert.match(h, /Ring Row \(upright\)/, 'recovery exercise named from the library');
  ctx.renderHome();   // last session card reads the newest legacy entry
  assert.match(html(ctx, 'home-content'), /Recovery session/);
});

test('replay: a recovery-mode entry and recovery.resetSeq give the same heavy-anchor result as before', () => {
  const log = [
    { date:'2026-07-02', sessionType:'RPush', sessionStatus:'stopped', coreComplete:true, sessionId:'22222222-bbbb', sessionSequence:0,
      performed:[ { slotId:'RPush_anchor_ring-pushup', exId:'ring-pushup', role:'anchor', progressionType:'heavyAnchor', reps:[8,8,8,8] } ] },
    { date:'2026-07-04', sessionType:'LP', sessionStatus:'completed', coreComplete:true, sessionId:'33333333-cccc', sessionSequence:1,
      performed:[ { slotId:'LP_anchor_split-squat', exId:'split-squat', role:'anchor', progressionType:'loose', reps:[8,8,8] } ] },
    { date:'2026-10-20', sessionType:'RPush', mode:'recovery', sessionStatus:'completed', coreComplete:true, sessionId:'44444444-dddd', sessionSequence:2,
      performed:[ { slotId:'RPush_builder_rec-incline-pushup', exId:'rec-incline-pushup', role:'builder', reps:[10,10] } ] }
  ];
  const run = (resetSeq) => {
    const { ctx } = recoveryBoot({ log, nextSessionSequence: 4, recovery: { on:false, cardioClear:true, since:null, offAt:'2026-10-26T00:00:00.000Z', resetSeq } });
    const full = JSON.parse(JSON.stringify(ctx.getState()));
    ctx.rebuildAnchorProgress(full);
    return full.anchorProgress;
  };
  const withReset = run(3);   // reset after the recovery entry, as a Settings turn-off used to write
  for(const slot of ['RPush_anchor_ring-pushup','A_anchor_ring-pullup','C_anchor_ring-pushup']){
    assert.equal(withReset[slot].externalLoad, 0, `${slot}: bodyweight`);
    assert.equal(withReset[slot].creditedQualityReps, null, `${slot}: fresh baseline pending`);
  }
  assert.equal(withReset['RPush_anchor_ring-pushup'].recoveryReset, true);
  // The recovery entry alone (no resetSeq) resets the anchors at its own point in the log.
  const entryOnly = run(undefined);
  assert.equal(entryOnly['RPush_anchor_ring-pushup'].externalLoad, 0);
  assert.equal(entryOnly['RPush_anchor_ring-pushup'].creditedQualityReps, null);
  // A normal post-reset session builds a fresh baseline, and a later replay keeps it.
  const { ctx } = recoveryBoot({ log, nextSessionSequence: 4, recovery: { on:false, cardioClear:true, since:null, offAt:'2026-10-26T00:00:00.000Z', resetSeq: 3 } });
  ctx.startSession('C'); completeGate(ctx, 5);
  if(AS_(ctx).phase === 'coreFork') ctx.finishAtFork();
  ctx.finalizeSession('completed');
  const full = JSON.parse(JSON.stringify(ctx.getState()));
  ctx.rebuildAnchorProgress(full);
  assert.equal(full.anchorProgress['C_anchor_ring-pushup'].externalLoad, 0);
  assert.equal(full.anchorProgress['C_anchor_ring-pushup'].creditedQualityReps, 10, '5 x 2 = the new baseline');
  ctx.deleteLogEntry(0);
  assert.equal(ctx.getState().anchorProgress['C_anchor_ring-pushup'].creditedQualityReps, 10);
});

test('the leave sheet always carries the generic warning signs, with no cardiology wording', () => {
  for(const extra of [{}, { recovery: OLD_RECOVERY }, { recovery: { on:false, cardioClear:true, since:null, offAt:null } }]){
    const { ctx } = recoveryBoot(extra);
    ctx.startSession('B');
    ctx.confirmStopSession();
    const body = ctx.document.getElementById('modal-body').textContent;
    assert.ok(body.includes('Chest pressure, unusual breathlessness, a racing or skipping heart, or light-headedness: End & save, then call your doctor; call 911 if it’s severe.'), body);
    assert.doesNotMatch(body, /cardiolog/i);
  }
});

test('no cardiology wording or retired recovery code anywhere in index.html or data.js', () => {
  for(const f of ['index.html','data.js']){
    const src = readFileSync(join(root,f),'utf8');
    assert.ok(!/cardiolog/i.test(src), `${f}: no cardiolog substring`);
    assert.ok(!/cardio/i.test(src), `${f}: no cardio substring`);
    assert.ok(!/RECOVERY_TEMPLATES|PT_LIST|REC_ACTIVATION|requiresCardioClear|recoveryDetail/.test(src), `${f}: retired data names are gone`);
  }
  const app = readFileSync(join(root,'index.html'),'utf8');
  assert.ok(!/startPtSession|renderPtScreen|renderPtCard|setRecoveryMode|isRecoveryOn|askArmCheck|ptLevels/.test(app));
});

test('release stamps: TRAIN_DATA_VERSION 8.1.0, cache-buster and BUILD_ID agree', () => {
  const { ctx } = boot();
  assert.equal(ctx.TRAIN_DATA_VERSION, '8.1.0');
  const app = readFileSync(join(root,'index.html'),'utf8');
  assert.match(app, /data\.js\?v=8\.1\.0"/);
  assert.match(app, /BUILD_ID = 'v8\.1\.1-2026-11-12-arm'/);
});

test('sync payload contract: every session type and legacy mode still validates and maps Mode / Arm Check / PT List', () => {
  const { ctx } = recoveryBoot();
  const mk = (o) => ({ sessionId:'s'.repeat(12), sessionSequence:1, date:'2026-10-15', completedAt:'2026-10-15T12:00:00.000Z',
    sessionStatus:'completed', coreComplete:true, performed:[], exerciseMeta:{}, issues:[], ...o });
  const cases = [
    ...['A','B','C','RP','LP','RPush','LS','RPr','MVS'].map(t=> ({ e: mk({ sessionType:t, mode:'normal' }), mode:'Normal', arm:undefined, pt:undefined })),
    ...['A','B','C','RP','LP','RPush','LS','RPr'].map(t=> ({ e: mk({ sessionType:t, mode:'recovery', armCheck:'worse' }), mode:'Recovery', arm:'Worse', pt:undefined })),
    { e: mk({ sessionType:'EN', coreComplete:null, engineKind:'Walk', duration:30 }), mode:undefined, arm:undefined, pt:undefined },
    { e: mk({ sessionType:'PT', mode:'recovery', ptList:true, armCheck:'better', ptItems:[{ name:'Supine chin tuck', dose:'3 x 10' }] }), mode:'Recovery', arm:'Better', pt:true },
    { e: mk({ sessionType:'RP' }), mode:undefined, arm:undefined, pt:undefined }
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

test('Form keeps its seven steps with the two permanent neck edits', () => {
  const { ctx } = recoveryBoot();
  assert.equal(ctx.FORM.screens.length, 7);
  const neck = ctx.FORM.screens[0].movements.find(m=> m.name === 'Neck + Scapular Setting').detail;
  assert.match(neck, /chin tucks/);
  assert.doesNotMatch(neck, /circles/);
  const bow = ctx.FORM.screens[6].movements.find(m=> /Bow/.test(m.name)).detail;
  assert.doesNotMatch(bow, /head heavy/);
  assert.match(bow, /head following the spine/);
});

test('symptom stop: first crossing stops the exercise and its gate counts; End arm work finishes the legs; Core never counts before the legs', () => {
  const { ctx } = recoveryBoot({ recovery: OLD_RECOVERY });
  ctx.startSession('A');
  skipForm(ctx);
  ctx.renderStation();
  assert.match(html(ctx, 'flow-foot'), /Symptom stop/, 'button on every exercise station');
  ctx.openSymptomStop();
  assert.doesNotMatch(ctx.document.getElementById('modal-body').textContent, /PT/);
  tap(ctx, 'End arm work, finish the legs');
  assert.equal(AS_(ctx).armWorkEnded, true);
  assert.equal(ctx.liveCoreComplete(), false, 'never instantly complete');
  completeGate(ctx, 10);
  if(AS_(ctx).phase === 'coreFork') ctx.finishAtFork();
  ctx.finalizeSession('completed');
  let s = ctx.getState();
  let e = s.log.slice(-1)[0];
  assert.equal(e.sessionStatus, 'completed');
  assert.equal(e.coreComplete, true);
  assert.equal(e.symptomStop, true);
  assert.equal(e.mode, 'normal');
  assert.equal(e.performed.find(p=> p.exId === 'ring-pullup').skipped, true, 'arm work passed over');
  assert.equal(s.rotationIndex, 1, 'a bad day never stalls the rotation');
  // a single crossing on an arm gate: that exercise stops and its gate still counts
  ctx.startSession('B');
  skipForm(ctx);
  logWholeExercise(ctx, 8);   // hinge
  logSet(ctx, 9);             // press, first set
  ctx.openSymptomStop();
  tap(ctx, 'Stop this exercise');
  logWholeExercise(ctx, 8);   // row
  assert.equal(AS_(ctx).phase, 'coreFork', 'stopped gate still counts: core complete');
  ctx.finishAtFork();
  ctx.finalizeSession('completed');
  e = ctx.getState().log.slice(-1)[0];
  assert.deepEqual(plain(e.symptomStops), ['hk-db-press']);
  assert.deepEqual(plain(e.performed.find(p=> p.exId === 'hk-db-press').reps), [9,0]);
});

test('Legs only today: arm work passed over and marked omitted; Core counts on the legs; no symptom stop; no anchor credit; labelled', () => {
  const { ctx } = recoveryBoot({ recovery: OLD_RECOVERY });
  ctx.startSession('A', { legsOnly:true });
  assert.equal(AS_(ctx).legsOnly, true);
  assert.equal(AS_(ctx).mode, 'normal');
  assert.equal(ctx.liveCoreComplete(), false);
  completeGate(ctx, 10);
  if(AS_(ctx).phase === 'coreFork') ctx.finishAtFork();
  ctx.finalizeSession('completed');
  const s = ctx.getState();
  const e = s.log.slice(-1)[0];
  assert.equal(e.legsOnly, true);
  assert.equal(e.coreComplete, true);
  assert.equal(e.symptomStop, undefined, 'legs only is a choice, not a symptom stop');
  const row = e.performed.find(p=> p.exId === 'ring-pullup');
  assert.equal(row.skipped, true);
  assert.equal(row.omitted, 'legsOnly');
  assert.equal(s.rotationIndex, 1);
  assert.equal(s.anchorProgress['A_anchor_ring-pullup'], undefined, 'a legs-only A never earns anchor credit');
  const wire = JSON.parse(JSON.stringify(ctx.buildSyncPayload(e)));
  assert.match(wire.sessionNote, /^Legs only today/);
  ctx.renderHistory();
  assert.match(html(ctx, 'history-content'), /Legs only/);
});

test('symptom stop on a leg day: the legs carry on, remaining arm work is passed over, no label points at it', () => {
  const { ctx } = recoveryBoot();
  ctx.startSession('LP');
  skipForm(ctx);
  ctx.openSymptomStop();
  tap(ctx, 'End arm work, finish the legs');
  assert.equal(AS_(ctx).armWorkEnded, true);
  completeGate(ctx, 10);
  if(AS_(ctx).phase === 'coreFork') ctx.keepGoingFromFork();
  while(AS_(ctx) && AS_(ctx).cursor < ctx.currentFlow().length && ctx.currentFlow()[AS_(ctx).cursor].kind === 'exercise' && !ctx.currentFlow()[AS_(ctx).cursor].arms) logWholeExercise(ctx, 8);
  ctx.finalizeSession('completed');
  const e = ctx.getState().log.slice(-1)[0];
  assert.equal(e.coreComplete, true);
  assert.equal(e.symptomStop, true);
  assert.equal(e.mode, 'normal');
});

test('a session frozen under the old recovery mode still resumes and finishes without throwing, and keeps its mode on the entry', () => {
  const tpl = { name:'A · Squat + Pull (recovery)', fullName:'Recovery: A', grip:'low', opener:true,
    blocks:[ { type:'builder', label:'Legs', core:true, gate:true, sets:2, exercises:['rec-split-squat'] },
             { type:'anchor', label:'Gate', core:true, gate:true, arms:true, exercises:['rec-incline-pushup'] } ] };
  const probe = boot();
  const flow = JSON.parse(JSON.stringify(probe.ctx.buildFlowFrom('A', tpl)));
  const records = {};
  flow.forEach(st=>{
    if(st.kind === 'exercise'){
      const n = st.sets || probe.ctx.EXERCISE_LIBRARY[st.exId].sets;
      records[st.uid] = { kind:'exercise', exId:st.exId, sets:new Array(n).fill(0), setStatus:new Array(n).fill('pending'), status:'pending', issueFlag:'none', note:'', quality:'unknown', painFree:'unknown' };
    } else records[st.uid] = { kind:st.kind, status:'pending' };
  });
  const frozen = { schemaVersion:9, type:'A', mode:'recovery', flow, tpl:{ name:tpl.name, fullName:tpl.fullName, grip:'low', noForm:false, opener:true, activation:null },
    armCheck:'same', startTime:Date.now(), activeMs:0, lastActiveAt:Date.now(), coreForkShown:false, cursor:0, phase:'view', setIdx:0,
    timerEnd:null, timerKind:null, records, sessionNote:'', issues:[] };
  const { ctx } = boot({ seed: { schemaVersion:9, progressionEngineVersion:3, rotationIndex:0, nextSessionOverride:null, nextSessionSequence:0,
    pendingDeletes:[], activeSession:frozen, legacy:{ promotions:{}, exerciseVariations:{}, promotionLog:[] }, anchorProgress:{}, log:[],
    recovery: OLD_RECOVERY, armCheck:{ date:'2000-01-01', value:'same' } } });
  assert.doesNotThrow(() => ctx.renderHome());
  assert.match(html(ctx, 'home-content'), /Session in progress/);
  assert.doesNotThrow(() => ctx.resumeSession());
  assert.ok(AS_(ctx), 'resumed with no arm-check question');
  assert.equal(AS_(ctx).mode, 'recovery');
  assert.doesNotThrow(() => { skipForm(ctx); ctx.renderStation(); });
  assert.doesNotThrow(() => { completeGate(ctx, 10); });
  if(AS_(ctx).phase === 'coreFork') ctx.finishAtFork();
  assert.doesNotThrow(() => ctx.finalizeSession('completed'));
  const s = ctx.getState();
  const e = s.log.slice(-1)[0];
  assert.equal(e.mode, 'recovery', 'the entry keeps the mode it started in, so replay stays identical');
  assert.equal(e.armCheck, 'same');
  assert.equal(e.coreComplete, true);
  assert.equal(s.activeSession, null);
  assert.doesNotThrow(() => ctx.renderHistory());
  assert.match(html(ctx, 'history-content'), /A · Squat \+ Pull \(recovery\)/);
  // a parked one expires cleanly too
  const b = boot({ seed: { schemaVersion:9, progressionEngineVersion:3, rotationIndex:0, nextSessionOverride:null, nextSessionSequence:0, pendingDeletes:[],
    activeSession:{ ...frozen, parkedAt:1, parkExpiresAt:2, lastActiveAt:null }, legacy:{ promotions:{}, exerciseVariations:{}, promotionLog:[] }, anchorProgress:{}, log:[], recovery: OLD_RECOVERY } });
  assert.doesNotThrow(() => b.ctx.renderHome());
  assert.equal(b.ctx.getState().activeSession, null, 'expired park finalized');
});

test('arm stations carry the arm-irritable line before loading; leg stations and ended arm work do not; Symptom stop names the same-day and emergency lists (v8.1.1)', () => {
  const { ctx } = recoveryBoot();
  ctx.startSession('B');
  skipForm(ctx);
  ctx.renderStation();
  assert.doesNotMatch(html(ctx, 'flow-body'), /Arm irritable today/, 'hinge is a leg station');
  logWholeExercise(ctx, 8);   // hinge
  ctx.renderStation();
  assert.match(html(ctx, 'flow-body'), /Arm irritable today\? Use an easier version you tolerate, or End arm work/, 'press is an arm station');
  ctx.openSymptomStop();
  const modal = ctx.document.getElementById('modal-body').textContent;
  assert.match(modal, /Same-day clinician assessment: new weakness or dropping things/);
  assert.match(modal, /Emergency care now: new trouble walking/);
  assert.match(modal, /bladder or bowel/);
  tap(ctx, 'End arm work, finish the legs');
  ctx.renderStation();
  assert.doesNotMatch(html(ctx, 'flow-body'), /Arm irritable today/, 'no line once arm work has ended');
});
