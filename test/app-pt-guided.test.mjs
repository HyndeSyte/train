// v7.4 guided PT's list: structured doses, the step plan, the hands-off timer, statuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function makeEl(){ return { innerHTML:'', textContent:'', value:'', style:{}, classList:{ add(){}, remove(){}, toggle(){} } }; }
function boot(){
  const els = {}; const storage = new Map();
  const seed = { schemaVersion:7, progressionEngineVersion:3, rotationIndex:0, nextSessionOverride:null, nextSessionSequence:0,
    pendingDeletes:[], activeSession:null, legacy:{ promotions:{}, exerciseVariations:{}, promotionLog:[] }, anchorProgress:{}, log:[] };
  storage.set('train_state', JSON.stringify(seed));
  const wake = { requested:0, released:0 };
  const ctx = {
    localStorage:{ getItem:k=>storage.has(k)?storage.get(k):null, setItem:(k,v)=>storage.set(k,String(v)), removeItem:k=>storage.delete(k) },
    document:{ getElementById(id){ if(!els[id]) els[id]=makeEl(); return els[id]; }, querySelectorAll(){ return []; }, addEventListener(){}, createElement(){ return makeEl(); }, body:{ addEventListener(){} }, visibilityState:'visible' },
    navigator:{ wakeLock:{ request(){ wake.requested++; return Promise.resolve({ release(){ wake.released++; }, addEventListener(){} }); } } },
    console, setTimeout, clearTimeout, Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Promise, crypto:undefined,
    alert(){}, prompt(){ return null; }, fetch(){ return Promise.reject(new Error('offline')); },
    URL:{ createObjectURL(){ return ''; }, revokeObjectURL(){} }, Blob: class {}, FileReader: class {},
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(root,'data.js'),'utf8'), ctx);
  const html = readFileSync(join(root,'index.html'),'utf8');
  const m = /<script>\n([\s\S]*)\n<\/script>/.exec(html);
  vm.runInContext(m[1] + '\n;globalThis.__PTS = () => PTS;', ctx);
  return { ctx, els, wake };
}
const plain = (x) => JSON.parse(JSON.stringify(x));

test('dose lines read as prescribed', () => {
  const { ctx } = boot();
  assert.equal(ctx.ptDoseLine({ sets:3, reps:1, holdSec:10 }), '3 x 10 s hold');
  assert.equal(ctx.ptDoseLine({ sets:3, reps:1, holdSec:10, perSide:true }), '3 x 10 s hold each side');
  assert.equal(ctx.ptDoseLine({ sets:3, reps:10 }), '3 x 10');
  assert.equal(ctx.ptDoseLine({ sets:2, reps:10, holdSec:3 }), '2 x 10, 3 s hold each');
});

test('plan: holds per side with switch and rest; reps wait for a tap', () => {
  const { ctx } = boot();
  const p = plain(ctx.buildPtPlan({ sets:2, reps:1, holdSec:10, perSide:true, restSec:10 }));
  assert.deepEqual(p.map(s=> s.kind), ['ready','hold','switch','hold','rest','hold','switch','hold']);
  assert.deepEqual(p.filter(s=> s.kind==='hold').map(s=> s.side), ['Right','Left','Right','Left']);
  const r = plain(ctx.buildPtPlan({ sets:3, reps:10, restSec:20 }));
  assert.deepEqual(r.map(s=> s.kind), ['reps','rest','reps','rest','reps']);
  const h = plain(ctx.buildPtPlan({ sets:1, reps:3, holdSec:5 }));
  assert.deepEqual(h.map(s=> s.kind), ['ready','hold','relax','hold','relax','hold']);
});

test('every PT item has a valid structured dose; every item has guidance', () => {
  const { ctx } = boot();
  const items = ctx.PT_LIST.items;
  assert.ok(items.length >= 7);
  const ids = new Set();
  items.forEach(it=>{
    assert.ok(it.id && !ids.has(it.id), 'unique id ' + it.id); ids.add(it.id);
    assert.ok(['open','pt','adds'].includes(it.block || 'pt'));
    assert.ok(it.ref && it.ref.cue && Array.isArray(it.ref.steps) && it.ref.steps.length >= 2 && it.ref.stop, it.id + ' guidance');
    assert.ok(Number.isInteger(it.sets) && it.sets >= 1, it.id + ' sets');
    assert.ok(Number.isInteger(it.reps) && it.reps >= 1, it.id + ' reps');
    assert.ok(it.holdSec == null || (it.holdSec > 0 && it.holdSec <= 60), it.id + ' hold');
    assert.ok(ctx.buildPtPlan(it).length >= 1);
  });
  // Order: the opener, then PT's program, then Train adds.
  const rank = { open:0, pt:1, adds:2 };
  const blocks = items.map(it=> rank[it.block || 'pt']);
  assert.deepEqual(plain(blocks), plain([...blocks].sort((a,b)=>a-b)));
  // PT's own seven items are all present.
  assert.equal(items.filter(it=> (it.block || 'pt') === 'pt').length, 7);
});

test('timer runs an item hands-off, then moves to the next open item', async () => {
  const { ctx, wake } = boot();
  ctx.startPtSession();
  // first session of the day asks the arm check; answer it
  if(!ctx.__PTS()) ctx.recordArmCheck ? null : null;
  let P = ctx.__PTS();
  if(!P){ ctx.document.getElementById('modal-actions'); ctx.recordArmCheck('same'); ctx.startPtSession(); P = ctx.__PTS(); }
  assert.ok(P, 'PT session open');
  ctx.ptOpen(0);
  ctx.ptStartItem();
  P = ctx.__PTS();
  assert.equal(P.run.plan[0].kind, 'ready');
  await Promise.resolve();
  assert.equal(wake.requested, 1, 'screen kept awake while the timer runs');
  // Fast-forward every timed step.
  let guard = 0;
  while(ctx.__PTS().run && ctx.__PTS().run.i === 0 && guard++ < 100){
    const st = ctx.__PTS().run.plan[ctx.__PTS().run.k];
    if(st.sec){ ctx.__PTS().run.endsAt = Date.now() - 1; ctx.ptTick(); } else ctx.ptSetDone();
  }
  P = ctx.__PTS();
  assert.equal(P.status[0], 'done');
  assert.equal(P.run.i, 1, 'next item is queued');
  assert.equal(P.run.plan, null, 'next item waits for its Start tap');
  assert.ok(wake.released >= 1, 'wake lock released between items');
  ctx.ptStopTimer();
});

test('pause freezes the countdown; resume restores it', () => {
  const { ctx } = boot();
  ctx.recordArmCheck('better');
  ctx.startPtSession();
  ctx.ptOpen(0); ctx.ptStartItem();
  const r = ctx.__PTS().run;
  r.endsAt = Date.now() + 4000;
  ctx.ptPause();
  assert.ok(r.paused && r.left > 3000 && r.left <= 4000);
  ctx.ptTick();   // paused: nothing advances
  assert.equal(r.k, 0);
  ctx.ptPause();
  assert.ok(!r.paused && r.endsAt - Date.now() > 3000);
  ctx.ptStopTimer();
});

test('a symptom stop marks the item stopped and logs it at Finish', () => {
  const { ctx } = boot();
  ctx.recordArmCheck('worse');
  ctx.startPtSession();
  // worse day: Train adds sit out
  ctx.renderPtScreen();
  assert.match(ctx.document.getElementById('pt-content').innerHTML, /Train adds sit out/);
  assert.doesNotMatch(ctx.document.getElementById('pt-content').innerHTML, /Slow shoulder shrugs/);
  ctx.ptOpen(4); ctx.ptStartItem(); ctx.ptItemDone('stopped');
  assert.equal(ctx.__PTS().status[4], 'stopped');
  ctx.ptOpen(5); ctx.ptItemDone('stopped');
  assert.match(ctx.document.getElementById('modal-title').textContent, /End today/, 'second stop offers to end the list');
  ctx.finishPtSession();
  const e = ctx.getState().log.slice(-1)[0];
  assert.equal(e.ptItems[4].status, 'stopped');
  assert.equal(e.ptItems[5].status, 'stopped');
  assert.equal(e.armCheck, 'worse');
});

test('an optional add that stops never downgrades a completed PT program', () => {
  const { ctx } = boot();
  ctx.recordArmCheck('same');
  ctx.startPtSession();
  const items = ctx.PT_LIST.items;
  items.forEach((it,i)=>{ if((it.block || 'pt') === 'pt'){ ctx.ptOpen(i); ctx.ptItemDone('done'); } });
  const add = items.findIndex(it=> it.block === 'adds');
  ctx.ptOpen(add); ctx.ptItemDone('stopped');
  ctx.finishPtSession();
  const e = ctx.getState().log.slice(-1)[0];
  assert.equal(e.sessionStatus, 'completed');
  assert.equal(e.ptItems[add].status, 'stopped');
});
