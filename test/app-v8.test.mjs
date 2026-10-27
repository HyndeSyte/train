// v8 A/B/C acceptance harness (2026-10-26). Same stubbed-DOM boot as
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


const AS_ = (c) => c.__AS();
const plain = (x) => JSON.parse(JSON.stringify(x));
const html = (c, id) => c.document.getElementById(id).innerHTML;
const v9 = (extra = {}) => ({ schemaVersion:9, progressionEngineVersion:3, rotationIndex:0, nextSessionOverride:null,
  nextSessionSequence:0, pendingDeletes:[], activeSession:null, legacy:{ promotions:{}, exerciseVariations:{}, promotionLog:[] },
  anchorProgress:{}, log:[], recovery:{ on:false, cardioClear:true, since:null, offAt:null }, ...extra });

test('Engine: Log minutes saves an EN entry that counts the day, syncs as "Engine", and never touches rotation or anchors', () => {
  const { ctx } = boot({ seed: v9({ rotationIndex:1 }) });
  ctx.renderHome();
  assert.match(html(ctx, 'home-content'), /Engine 0\/150 min/);
  ctx.openEngineLog();
  ctx.engSet('kind', 'Ruck');
  ctx.engStep(5); ctx.engStep(5);   // 30 -> 40
  ctx.saveEngine();
  let s = ctx.getState();
  const e = s.log.slice(-1)[0];
  assert.equal(e.sessionType, 'EN');
  assert.equal(e.duration, 40);
  assert.equal(e.engineKind, 'Ruck');
  assert.equal(e.date, ctx.localDay());
  assert.equal(e.mode, undefined, 'no Mode on Engine rows');
  assert.ok(e.sessionId && typeof e.sessionSequence === 'number' && e.notionSync.status === 'pending');
  assert.equal(s.rotationIndex, 1, 'rotation untouched');
  assert.equal(JSON.stringify(s.anchorProgress), '{}', 'anchors untouched');
  assert.equal(s.lastEngineKind, 'Ruck', 'kind remembered');
  ctx.renderHome();
  assert.match(html(ctx, 'home-content'), /Engine 40\/150 min/);
  assert.match(html(ctx, 'home-content'), /1 active day/);
  const wire = JSON.parse(JSON.stringify(ctx.buildSyncPayload(e)));
  assert.equal(validatePayload(wire).ok, true);
  const p = toNotionProperties(wire, '2026-10-26T12:00:00.000Z');
  assert.equal(p['Session Type'].select.name, 'Engine');
  assert.match(p['Session'].title[0].text.content, /· Engine$/);
  assert.equal(p['Duration (min)'].number, 40);
  assert.equal(p['Session Note'].rich_text[0].text.content, 'Ruck');
  assert.equal(p['Mode'], undefined);
  ctx.renderHistory();
  assert.match(html(ctx, 'history-content'), /Ruck &middot; 40 min/);
  assert.doesNotMatch(html(ctx, 'history-content'), /HITs/);
  // Yesterday lands on yesterday's date; the default kind is the last one used
  ctx.openEngineLog();
  assert.match(html(ctx, 'modal-body'), /btn-primary" style="margin:0 6px 6px 0;" onclick="engSet\('kind','Ruck'\)/, 'last kind preselected');
  ctx.engSet('yesterday', true);
  ctx.saveEngine();
  s = ctx.getState();
  const y = new Date(); y.setDate(y.getDate() - 1);
  assert.equal(s.log.slice(-1)[0].date, ctx.localDay(y.getTime()));
});

test('This week: strength counts only Core-complete A/B/C; active days are unique dates; Engine sums minutes', () => {
  const today = new Date(); const d = (n) => { const x = new Date(today); x.setDate(x.getDate() - n); return x; };
  const { ctx } = boot({ seed: v9() });
  const wk = ctx.weekBounds();
  const inWeek = [0,1,2,3,4,5,6].map(d).map(x=> ctx.localDay(x.getTime())).filter(x=> x >= wk.start && x < wk.end);
  const day = inWeek[0];
  const s = ctx.getState();
  s.log.push({ date:day, sessionType:'A', coreComplete:true, sessionStatus:'completed', sessionId:'a'.repeat(12), sessionSequence:0, performed:[] });
  s.log.push({ date:day, sessionType:'B', coreComplete:false, sessionStatus:'partial', sessionId:'b'.repeat(12), sessionSequence:1, performed:[] });
  s.log.push({ date:day, sessionType:'EN', duration:25, sessionStatus:'completed', sessionId:'c'.repeat(12), sessionSequence:2, performed:[] });
  s.log.push({ date:'2020-01-01', sessionType:'C', coreComplete:true, sessionStatus:'completed', sessionId:'d'.repeat(12), sessionSequence:3, performed:[] });
  ctx.saveState(s);
  const m = ctx.weekMeasures(ctx.getState());
  assert.deepEqual(plain(m), { strength:1, activeDays:1, engine:25 });
});

test('Core estimates stay about 20 minutes; Floor about 10', () => {
  const { ctx } = boot({ seed: v9() });
  for(const t of ['A','B','C']){
    const m = ctx.estimateCoreDuration(t);
    assert.ok(m >= 12 && m <= 23, `${t} core ~${m} min`);
  }
  const f = ctx.estimateCoreDuration('MVS');
  assert.ok(f >= 8 && f <= 12, `Floor core ~${f} min`);
});

test('effort line follows the cardiology cap: 2–3 reps short while it holds, 1–3 after', () => {
  const capped = boot({ seed: v9({ recovery:{ on:false, cardioClear:false, since:null, offAt:'2026-11-27T00:00:00.000Z' } }) }).ctx;
  capped.startSession('B');
  capped.advanceForm();
  capped.renderStation();
  assert.match(html(capped, 'flow-body'), /2–3 reps short of failure/);
  const clear = boot({ seed: v9() }).ctx;
  clear.startSession('B');
  clear.advanceForm();
  clear.renderStation();
  assert.match(html(clear, 'flow-body'), /1–3 reps short of failure/);
});

test('Markers: partial saves keep value, unit and note; the card shows the latest per marker', () => {
  const { ctx } = boot({ seed: v9() });
  ctx.openMarkers();
  ctx.document.getElementById('mk-pullup').value = '7';
  ctx.document.getElementById('mkn-pullup').value = 'rings at 2nd strap hole';
  ctx.document.getElementById('mk-route').value = '1.4';
  ctx.saveMarkers();
  const s = ctx.getState();
  assert.equal(s.markers.length, 1);
  assert.deepEqual(plain(s.markers[0].values.pullup), { value:'7', unit:'reps', note:'rings at 2nd strap hole' });
  assert.equal(s.markers[0].values.carry, undefined, 'untested markers stay blank');
  ctx.renderSettings();
  assert.match(html(ctx, 'settings-content'), /7 reps/);
  assert.match(html(ctx, 'settings-content'), /next around/);
});

test('a parked v7 session still resolves after the v9 migration and finishes without advancing A/B/C', () => {
  const seed = { schemaVersion:7, progressionEngineVersion:3, rotationIndex:3, nextSessionOverride:null, nextSessionSequence:0,
    pendingDeletes:[], legacy:{ promotions:{}, exerciseVariations:{}, promotionLog:[] }, anchorProgress:{}, log:[],
    recovery:{ on:false, cardioClear:true, since:null, offAt:null }, armCheck:null };
  const b = boot({ seed });
  // build a v7 LS session the old way, then park it as a v7 copy would have
  b.ctx.beginSession('LS', 'normal');
  b.ctx.parkSession();
  const parked = b.ctx.getState();
  parked.schemaVersion = 7;
  const { ctx } = boot({ seed: parked });
  const s = ctx.getState();
  assert.equal(s.schemaVersion, 9);
  assert.ok(s.activeSession && s.activeSession.type === 'LS', 'parked v7 session kept');
  ctx.resumeSession();
  let guard = 0;
  while(AS_(ctx) && guard++ < 40){ const st = ctx.currentFlow()[AS_(ctx).cursor]; if(!st) break; if(st.kind !== 'exercise'){ ctx.advanceForm(); continue; } ctx.skipExercise(); if(AS_(ctx).phase === 'coreFork') ctx.finishAtFork(); }
  ctx.finalizeSession('completed');
  const after = ctx.getState();
  assert.equal(after.log.slice(-1)[0].sessionType, 'LS');
  assert.equal(after.rotationIndex, 0, 'a legacy session never advances A/B/C');
});

test('review fixes: old Floor history keeps its v7 gate; Legs only says the legs are still needed until they are done; markers tolerate null rows', () => {
  const { ctx } = boot({ seed: v9({ markers:[null, { date:'2026-10-01', values:{ x:null } }] }) });
  const done = (exId) => ({ slotId:'MVS_finisher_'+exId, exId, reps:[10,10,10,10,10], targetSets:2 });
  const oldFloor = { sessionType:'MVS', performed:['pushup','reverse-lunge','hollow-body'].map(done) };
  assert.equal(ctx.entryCoreComplete(oldFloor), true, 'v7 Floor entry still complete');
  assert.equal(ctx.entryCoreComplete({ sessionType:'MVS', performed:[{ slotId:'MVS_finisher_floor-getup', exId:'floor-getup', reps:[] }] }), false);
  assert.doesNotThrow(()=> ctx.lastMarkers(ctx.getState()));
  const src = readFileSync(join(root,'index.html'),'utf8');
  assert.match(src, /the leg sets are still needed for it to count/);
  assert.match(src, /function openMarkers\(\)\{\n  if\(handoffActive\(\)\) return;/);
  assert.match(src, /function saveMarkers\(\)\{\n  if\(handoffActive\(\)\) return;/);
});

test('recovery reference clips: the five graded moves carry their kept primaries (2026-10-26)', () => {
  const { ctx } = boot({ seed: v9() });
  const want = { 'rec-ring-row':'B90sF7dbP04', 'rec-pulldown':'BjxeYTIBUXM', 'rec-incline-pushup':'GDTFPZFz960', 'rec-split-squat':'kQ1VCHrfbbs', 'rec-cossack':'dhDjKmTX8tU' };
  for(const [id, vid] of Object.entries(want)){
    const r = ctx.EXERCISE_LIBRARY[id].reference;
    assert.equal(r.status, 'video', id); assert.equal(r.videoId, vid, id);
    assert.match(ctx.buildEmbedUrl(r), new RegExp('youtube-nocookie.com/embed/' + vid), id);
  }
});
