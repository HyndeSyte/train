// R0 guards: migrate() repairs a missing or bad rotationIndex, and boot asks for persistent storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function makeEl(){ return { innerHTML:'', textContent:'', value:'', checked:false, style:{}, classList:{ add(){}, remove(){}, toggle(){} } }; }

function boot(opts = {}){
  const els = {}; const listeners = {};
  const storage = new Map(opts.seed ? [['train_state', JSON.stringify(opts.seed)]] : []);
  const ctx = {
    localStorage:{ getItem:k=>storage.has(k)?storage.get(k):null, setItem:(k,v)=>storage.set(k,String(v)), removeItem:k=>storage.delete(k) },
    document:{ getElementById(id){ if(!els[id]) els[id]=makeEl(); return els[id]; }, querySelectorAll(){ return []; },
      addEventListener(name, fn){ (listeners[name] = listeners[name] || []).push(fn); }, createElement(){ return makeEl(); },
      body:{ addEventListener(){}, innerHTML:'' }, visibilityState:'visible' },
    navigator: opts.navigator || {}, console, setTimeout, clearTimeout, Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Promise, crypto:undefined,
    alert(){}, prompt(){ return null; }, fetch(){ return Promise.reject(new Error('offline')); },
    URL:{ createObjectURL(){ return ''; }, revokeObjectURL(){} }, Blob: class {}, FileReader: class {},
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(root,'data.js'),'utf8'), ctx);
  const html = readFileSync(join(root,'index.html'),'utf8');
  const m = /<script>\n([\s\S]*)\n<\/script>/.exec(html);
  vm.runInContext(m[1] + '\n;globalThis.ROTATION = ROTATION;', ctx);
  return { ctx, els, storage, listeners };
}
const base = () => ({ schemaVersion:8, progressionEngineVersion:3, nextSessionOverride:null, nextSessionSequence:0,
  pendingDeletes:[], activeSession:null, legacy:{ promotions:{}, exerciseVariations:{}, promotionLog:[] }, anchorProgress:{}, log:[] });

test('migrate: a missing, string, NaN or null rotationIndex becomes 0; numbers wrap into the rotation', () => {
  const { ctx } = boot();
  for(const bad of [undefined, null, 'RP', NaN, Infinity, {}, true]){
    const s = base(); if(bad !== undefined) s.rotationIndex = bad;
    assert.equal(ctx.migrate(s).rotationIndex, 0, 'bad value ' + String(bad));
  }
  assert.equal(ctx.migrate(Object.assign(base(), { rotationIndex: 7 })).rotationIndex, 7 % ctx.ROTATION.length);
  assert.equal(ctx.migrate(Object.assign(base(), { rotationIndex: -1 })).rotationIndex, ctx.ROTATION.length - 1);
  assert.equal(ctx.migrate(Object.assign(base(), { rotationIndex: 2.7 })).rotationIndex, 2);
});

test('a state without rotationIndex renders Home and can finish a session', () => {
  const seed = base(); // no rotationIndex at all
  const { ctx } = boot({ seed });
  ctx.renderHome();
  assert.equal(typeof ctx.getState().rotationIndex, 'number');
  assert.equal(ctx.getDefaultSessionType(ctx.getState()), ctx.ROTATION[0]);
});

test('boot asks for persistent storage when the API exists, and survives its absence or refusal', async () => {
  let persistCalls = 0;
  const { ctx, listeners } = boot({ navigator: { storage: { persist(){ persistCalls++; return Promise.resolve(false); } } } });
  assert.ok(listeners.DOMContentLoaded && listeners.DOMContentLoaded.length === 1, 'one boot handler');
  await listeners.DOMContentLoaded[0]();
  assert.equal(persistCalls, 1);
  // no navigator.storage at all
  const b2 = boot({ navigator: {} });
  await b2.listeners.DOMContentLoaded[0]();
  // persist throwing synchronously
  const b3 = boot({ navigator: { storage: { persist(){ throw new Error('no'); } } } });
  await b3.listeners.DOMContentLoaded[0]();
  assert.ok(true, 'boot completed in all three cases');
});

test('the stale v4 files are gone', () => {
  assert.equal(existsSync(join(root, 'index-v4.html')), false);
  assert.equal(existsSync(join(root, 'wireframes-v4.html')), false);
});

test('code comments no longer name the condition or the PT portal (user-facing copy is allowed to)', () => {
  // The terms are base64 so this file does not spell them out in the public repo.
  const banned = new RegExp(Buffer.from('Y3ViaXRhbHxyYWRpY3Vsb3BhdGh8dGhvcmFjaWMgb3V0bGV0fEl2eSBDYXJlfFN5bmVyZ3k=', 'base64').toString('utf8'), 'i');
  const files = ['index.html', 'data.js'];
  for(const f of files){
    const src = readFileSync(join(root, f), 'utf8');
    const comments = [...src.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g)].map(m=>m[0]).join('\n');
    assert.doesNotMatch(comments, banned, f + ' comments');
  }
});
