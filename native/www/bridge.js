// bridge.js: the native shell's side of the web app (plan v4, R2 build order 1 and 2).
// Loaded by the shell's patched copy of index.html after the inline script and before
// DOMContentLoaded fires. The live index.html, data.js and style.css are never edited.
//
// What this file does:
//   - one writer: the three sync functions are no-ops at parse time (the shell never posts before
//     cutover); a quiescing guard shape exists for the later serialized wrappers;
//   - never handed off: handoffSupported() is false, so the hand-off release's switch, backstop,
//     hold and banner never run here;
//   - the durable store: the awaited ready-hook hydrates localStorage from the native file before
//     anything calls getState(), applying the plan's rules in order; saveState is wrapped as a
//     compare-and-swap write chain with lineage (seedRev) and a store generation;
//   - Import and Erase are native transactions (snapshot, disarm, generation bump, commit, reload);
//   - Export waits for the last save to be acknowledged and exports the committed head, or both
//     copies labelled when it cannot;
//   - parity (build order 3 and 4): navigator.wakeLock is polyfilled over the native idle timer; the six
//     cues play natively (audio plus haptic) behind soundEnabled(), with unlockAudio and toneW as no-ops
//     so the shell never creates an AudioContext; the train_sound_off key rides in the store's control
//     sidecar; buildEmbedUrl points YouTube embeds at the https wrapper page on Pages.
// localStorage stays the synchronous working copy; the file is the durability backstop.
(function (w) {
  'use strict';

  var STATE_KEY = 'train_state';
  var SEED_KEY = 'train_seed_rev';
  var GEN_KEY = 'train_store_gen';
  var SNAP_KEY = 'train_state_snapshot';
  var REFUSED_KEY = 'train_store_refused';       // set when the store refused this page's save; cleared by the next seeding
  var SOUND_KEY = 'train_sound_off';              // the app's own key; mirrored in the store's control sidecar
  var cfg = w.__storeConfig || {};               // tests shorten the waits; the app uses the defaults
  var EMBED_BASE = cfg.embedBase || 'https://hyndesyte.github.io/train/embed.html';
  var EMBED_TEST_ID = 'M7lc1UVf-VE';              // the IFrame Player API reference's example video (test only)
  var READ_RETRY_MS = cfg.readRetryMs || 5000;
  var QUIESCE_MS = cfg.quiesceMs || 10000;
  var EXPORT_WAIT_MS = cfg.exportWaitMs || 3000;
  var EMBED_TIMEOUT_MS = cfg.embedTimeoutMs || 45000;   // the uiTest embed probe gives the player this long

  // --- hand-off: never in the shell ---
  w.handoffSupported = function () { return false; };

  // --- sync off before cutover; the guard the real wrappers will honour ---
  var sync = w.__sync = { inflight: 0, quiescing: false };
  function syncRefused() { note({ syncRefused: 'quiescing' }); return { refused: 'quiescing' }; }
  w.pushUnsynced = async function () { if (sync.quiescing) return syncRefused(); return; };
  w.syncEntry = async function () { if (sync.quiescing) return syncRefused(); return; };
  w.postSync = async function () { if (sync.quiescing) { syncRefused(); throw new Error('sync is quiescing'); } throw new Error('sync is off in the shell before cutover'); };

  var store = w.__store = {
    seeded: false, base: 0, rev: 0, seedRev: 0, generation: null,
    refused: false, pendingSaves: 0, inflightSaves: 0, lastSaveFailed: false, lastCommitted: null,
    chain: Promise.resolve(), txHold: null, snapshot: null, banner: null, hydrated: false, readyPromise: null, events: [], logRing: [],
    launch: null, embed: null,
    config: { readRetryMs: READ_RETRY_MS, quiesceMs: QUIESCE_MS, exportWaitMs: EXPORT_WAIT_MS, embedTimeoutMs: EMBED_TIMEOUT_MS }
  };
  function note(ev) { store.events.push(ev); if (store.events.length > 200) store.events.shift(); }
  function msg(e) { return String(e && e.message || e); }

  // --- log capture: the last 200 console and error lines, written to the app's log (Library/Logs/train.log,
  // rotated by the plugin) when a banner shows or a save is refused. No UI; the test summary carries the tail.
  function logLine(level, args) {
    var parts = Array.prototype.map.call(args || [], function (a) { try { return typeof a === 'string' ? a : (a && a.stack) || JSON.stringify(a); } catch (e) { return String(a); } });
    store.logRing.push((new Date().toISOString() + ' ' + level + ' ' + parts.join(' ')).slice(0, 500));
    if (store.logRing.length > 200) store.logRing.shift();
  }
  (function captureConsole() {
    var c = w.console; if (!c) return;
    ['log', 'warn', 'error'].forEach(function (level) {
      var orig = c[level];
      c[level] = function () { logLine(level, arguments); if (typeof orig === 'function') orig.apply(c, arguments); };
    });
    if (typeof w.addEventListener === 'function') {
      w.addEventListener('error', function (ev) { logLine('uncaught', [ev && (ev.message || ev.error)]); });
      w.addEventListener('unhandledrejection', function (ev) { logLine('unhandledrejection', [ev && ev.reason]); });
    }
  })();
  function flushLog(reason) {
    var text = '--- ' + new Date().toISOString() + ' ' + reason + ' | rev ' + store.rev + ' base ' + store.base + ' generation ' + store.generation + '\n'
      + store.logRing.join('\n') + (store.logRing.length ? '\n' : '')
      + 'events ' + JSON.stringify(store.events.slice(-12)) + '\n';
    return call('TrainStore', 'appendLog', { text: text }).catch(function (e) { note({ logWriteFailed: msg(e) }); });
  }

  // --- plugins ---
  function pl(name) { var p = w.Capacitor && w.Capacitor.Plugins; return p && p[name]; }
  function call(name, method, opts) {
    var p = pl(name);
    if (!p || typeof p[method] !== 'function') return Promise.reject(new Error('no plugin ' + name + '.' + method));
    return p[method](opts || {});
  }

  // --- small utilities ---
  function sha256Hex(str) {
    return w.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }
  function sessionIds(obj) { return ((obj && obj.log) || []).map(function (e) { return e && e.sessionId; }).filter(function (x) { return typeof x === 'string' && x.length; }).sort(); }
  function digestOf(obj) { return sha256Hex(sessionIds(obj).join('\n')).then(function (h) { return h.slice(0, 8); }); }
  function safeParse(str) { try { return JSON.parse(str); } catch (e) { return null; } }
  function localRaw() { try { return w.localStorage.getItem(STATE_KEY); } catch (e) { return null; } }
  function lsGet(k) { try { return w.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { w.localStorage.setItem(k, v); } catch (e) { w.console.error('bridge: localStorage write failed', e); } }
  function lsDel(k) { try { w.localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function waitFor(pred, ms) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function tick() {
        if (pred()) return resolve(true);
        if (Date.now() - start >= ms) return resolve(false);
        w.setTimeout(tick, 25);
      })();
    });
  }
  function hhmm(iso) { try { var d = new Date(iso); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso; } }

  // --- tiny DOM surfaces (defensive: the Node harness stubs document) ---
  function el(id, tag) {
    var d = w.document; var e = d.getElementById(id);
    if (!e) { e = d.createElement(tag || 'div'); e.id = id; (d.body || d.documentElement).appendChild(e); }
    return e;
  }
  function showLoading(text, retry) {
    var v = el('store-loading');
    v.setAttribute('style', 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;background:var(--bg,#0f1115);color:var(--text,#e6e6e6);font:15px/1.5 -apple-system,system-ui,sans-serif;');
    v.innerHTML = '<div id="store-loading-text"></div>' + (retry ? '<button id="store-loading-retry" class="btn btn-primary" style="max-width:220px;">Retry</button>' : '');
    el('store-loading-text').textContent = text;
    if (retry) el('store-loading-retry', 'button').onclick = retry;
    v.hidden = false;
    store.loading = { text: text, retry: !!retry };
  }
  // the inline style sets display:flex, which beats the hidden attribute, so hide by display too
  function hideLoading() { var v = w.document.getElementById('store-loading'); if (v) { v.hidden = true; v.style.display = 'none'; v.innerHTML = ''; } store.loading = null; }
  function showBanner(text, opts) {
    store.banner = { text: text, snapshot: !!(opts && opts.snapshot) };
    var b = el('store-banner');
    b.setAttribute('role', 'alert');
    b.setAttribute('style', 'position:fixed;left:8px;right:8px;top:8px;z-index:9998;padding:10px 12px;border-radius:10px;background:var(--warn-dim,#3a2a00);border:1px solid var(--warn,#e0a800);color:var(--text,#e6e6e6);font:13px/1.45 -apple-system,system-ui,sans-serif;');
    b.innerHTML = '<div id="store-banner-text"></div><div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">'
      + (store.banner.snapshot ? '<button id="store-banner-export" class="btn btn-small btn-secondary">Export the saved snapshot</button>' : '')
      + '<button id="store-banner-close" class="btn btn-small btn-secondary">Dismiss</button></div>';
    el('store-banner-text').textContent = text;
    if (store.banner.snapshot) el('store-banner-export', 'button').onclick = function () { exportSnapshot(); };
    el('store-banner-close', 'button').onclick = function () { hideBanner(); };
    b.hidden = false;
    flushLog('banner: ' + text.slice(0, 120));
  }
  function hideBanner() { var b = w.document.getElementById('store-banner'); if (b) { b.hidden = true; b.style.display = 'none'; b.innerHTML = ''; } store.banner = null; }

  // --- seeding: rev, seedRev and generation move together, persisted before any save is sent ---
  function seed(rev, seedRev, generation) {
    store.base = rev; store.rev = rev; store.seedRev = seedRev; store.generation = generation; store.seeded = true;
    lsSet(SEED_KEY, String(seedRev)); lsSet(GEN_KEY, String(generation));
    lsDel(REFUSED_KEY);
  }

  // --- hydration (the awaited ready-hook) ---
  function readStore() {
    return new Promise(function (resolve) {
      var settled = false;
      function attempt() {
        showLoading('Loading your saved data…');
        var slow = w.setTimeout(function () { if (!settled) showLoading('Still loading your saved data…', attempt); }, READ_RETRY_MS);
        call('TrainStore', 'read').then(function (r) {
          w.clearTimeout(slow);
          if (settled) return;            // a late read never hydrates
          settled = true; resolve(r);
        }, function (e) {
          w.clearTimeout(slow);
          if (settled) return;
          note({ readFailed: msg(e) });
          showLoading('Could not read your saved data (' + msg(e) + ').', attempt);
        });
      }
      attempt();
    });
  }

  function mandatoryKeys(o) {
    return !!(o && typeof o === 'object' && Array.isArray(o.log) && typeof o.rotationIndex === 'number' && typeof o.schemaVersion === 'number' && o.legacy && typeof o.legacy === 'object' && o.anchorProgress && typeof o.anchorProgress === 'object');
  }
  // Validate a PARSED copy; the raw string is what gets written through.
  function validRaw(raw) {
    var parsed = safeParse(raw); if (!parsed) return false;
    try { var m = (typeof w.migrate === 'function') ? w.migrate(parsed) : parsed; return mandatoryKeys(m); } catch (e) { return false; }
  }
  function keepBoth(reason, raw, file) {
    var parsed = safeParse(raw);
    var snap = { at: new Date().toISOString(), reason: reason, rev: (parsed && parsed._rev) || 0, bytes: raw };
    lsSet(SNAP_KEY, JSON.stringify(snap));
    store.snapshot = snap;
    if (file.bytes != null) lsSet(STATE_KEY, file.bytes); else lsDel(STATE_KEY);
    store.lastCommitted = file.bytes != null ? { rev: file.rev, bytes: file.bytes } : null;
    seed(file.rev, file.rev, file.generation);
    note({ keepBoth: reason, fileRev: file.rev, localRev: snap.rev });
    return describeSnapshot(snap).then(function (d) {
      showBanner('Loaded the app’s saved copy (rev ' + file.rev + '). This screen’s previous copy (' + d + ') is kept as a snapshot: Settings → Export the saved snapshot.', { snapshot: true });
    });
  }
  function describeSnapshot(snap) {
    var parsed = safeParse(snap.bytes);
    var n = sessionIds(parsed).length;
    return digestOf(parsed).then(function (d) { return n + ' session' + (n === 1 ? '' : 's') + ' · digest ' + d; }, function () { return n + ' session' + (n === 1 ? '' : 's'); });
  }

  async function hydrate() {
    var res = await readStore();
    var file = { rev: Number(res && res.rev) || 0, generation: Number(res && res.generation) || 0, bytes: (res && res.hasFile && typeof res.bytes === 'string') ? res.bytes : null, hash: (res && typeof res.hash === 'string') ? res.hash : null };
    var raw = localRaw();
    if (res && res.recovered) note({ recoveredFrom: res.recoveredFrom });
    if (res && res.healed) note({ healed: file.rev });        // native filled control.rev from the bytes (a kill between two writes)
    hydrateSoundKey(res);
    // 1. train_state missing: hydrate from the file; no candidate, no comparison
    if (raw === null) {
      if (file.bytes != null) lsSet(STATE_KEY, file.bytes);
      store.lastCommitted = file.bytes != null ? { rev: file.rev, bytes: file.bytes } : null;
      seed(file.rev, file.rev, file.generation);
      note({ rule: 'missing', fileRev: file.rev });
      if (res && res.recovered) showBanner('Your saved data was restored from the app’s newest good snapshot (' + res.recoveredFrom + ').');
      return;
    }
    var localObj = safeParse(raw);
    var localRev = (localObj && typeof localObj._rev === 'number') ? localObj._rev : 0;
    // a present train_state with no bookkeeping key never enters write-through: a missing key is NaN, not 0
    var localGen = lsGet(GEN_KEY) === null ? NaN : Number(lsGet(GEN_KEY));
    var localSeed = lsGet(SEED_KEY) === null ? NaN : Number(lsGet(SEED_KEY));
    var refusedBefore = lsGet(REFUSED_KEY) === '1';
    // unreadable local copy: treat as a candidate to keep, load the file
    if (!localObj) return keepBoth('unreadable', raw, file);
    // 2. generation differs: an Import, Erase or snapshot recovery this page did not see
    if (!(localGen === file.generation)) return keepBoth('generation', raw, file);
    // 3. the file is ahead
    if (file.rev > localRev) {
      lsSet(STATE_KEY, file.bytes);
      store.lastCommitted = { rev: file.rev, bytes: file.bytes };
      seed(file.rev, file.rev, file.generation);
      note({ rule: 'fileAhead', fileRev: file.rev, localRev: localRev });
      return;
    }
    // 4. this page is ahead within its own acknowledged lineage: write through the raw string. A page the
    //    store refused keeps stamping, so its marker counts like a seedRev above the file: keep both.
    if (localRev > file.rev) {
      if (refusedBefore) note({ refusedMarker: true, localRev: localRev, fileRev: file.rev });
      if (!refusedBefore && Number.isFinite(localSeed) && localSeed <= file.rev) {
        if (validRaw(raw)) {
          var r = await call('TrainStore', 'save', { base: file.rev, bytes: raw, generation: file.generation }).catch(function (e) { return { accepted: false, reason: 'error:' + msg(e) }; });
          if (r && r.accepted) {
            store.lastCommitted = { rev: r.rev, bytes: raw };
            seed(r.rev, r.rev, file.generation);
            note({ rule: 'writeThrough', fileRev: file.rev, localRev: localRev });
            return;
          }
          note({ rule: 'writeThroughRefused', reason: r && r.reason });
        }
        return keepBoth('invalidOrRefused', raw, file);
      }
      // 5. the file moved under this page
      return keepBoth('moved', raw, file);
    }
    // 6. equal revs: compare the content hashes
    var localHash = await sha256Hex(raw);
    if (file.bytes != null && localHash === file.hash) {
      store.lastCommitted = { rev: file.rev, bytes: file.bytes };
      seed(file.rev, file.rev, file.generation);
      note({ rule: 'equal', rev: file.rev });
      return;
    }
    if (file.bytes == null && localRev === 0) {
      // nothing on either side (a fresh WebView store with an unsaved default): the file wins
      seed(0, 0, file.generation);
      note({ rule: 'bothEmpty' });
      return;
    }
    return keepBoth('diverged', raw, file);
  }

  // Test and smoke runs: `-trainFixture <name>` imports a bundled synthetic fixture into an empty
  // store on first launch. A real launch has no such argument.
  async function maybeImportFixture() {
    var o; try { o = await call('TrainStore', 'launchOptions'); } catch (e) { return; }
    store.launch = o || null;
    if (o && o.reset) {
      // -trainResetStore (CI only): an empty phone for this launch, so the UI tests do not share state
      try { w.localStorage.clear(); } catch (e) { /* ignore */ }
      var er = await call('TrainStore', 'erase');
      note({ reset: !!(er && er.accepted), generation: er && er.generation });
    }
    if (!o || !o.fixture) return;
    if (localRaw() !== null) return;
    var st = await call('TrainStore', 'status');
    if (!st || st.hasFile || (st.rev || 0) !== 0) return;
    var resp = await w.fetch('fixtures/' + o.fixture + '.json', { cache: 'no-store' });
    note({ fixtureFetch: resp && resp.status, ok: resp && resp.ok, url: resp && resp.url });
    if (!resp || !resp.ok) throw new Error('fixture fetch ' + (resp && resp.status));
    var data = await resp.json();
    var bytes = prepareImportBytes(data, 0);
    var r = await call('TrainStore', 'importState', { bytes: bytes, base: 0 });
    note({ fixture: o.fixture, imported: !!(r && r.accepted), reason: r && r.reason, rev: r && r.rev, generation: r && r.generation });
  }

  w.__trainReady = function () {
    if (!store.readyPromise) {
      showLoading('Loading your saved data…');          // cover the nav from the first IPC
      store.readyPromise = (async function () {
        releaseAllSentinels('hydration');                // a reload never inherits an idle-timer hold
        try { await maybeImportFixture(); } catch (e) { note({ fixtureFailed: msg(e), stack: String(e && e.stack || '').slice(0, 300) }); }
        await hydrate();
        store.hydrated = true;
        hideLoading();
        reportGate0();
      })();
    }
    return store.readyPromise;
  };

  // Gate 0's report, kept until the smoke test replaces it: one in-app plugin call, one Capacitor
  // plugin call, secure context and origin, plus the bridge's event notes, handed to native for the
  // UI tests to read.
  function reportGate0() {
    var p = w.Capacitor && w.Capacitor.Plugins;
    var result = { bridge: { hasCapacitor: !!w.Capacitor, hasPlugins: !!p, pluginNames: p ? Object.keys(p).sort() : [] }, trainStore: null, capPlugin: null, isSecureContext: w.isSecureContext === true, origin: w.location.origin, errors: [], events: store.events.slice(-12), rev: store.rev, generation: store.generation, logLines: store.logRing.length };
    w.__gate0 = result;
    return call('TrainStore', 'ping', { echo: 'gate0' })
      .then(function (r) { result.trainStore = { via: 'proxy', value: r }; }, function (e) { result.errors.push('TrainStore.ping: ' + msg(e)); })
      .then(function () { return call('Filesystem', 'getUri', { path: 'gate0.txt', directory: 'LIBRARY' }); })
      .then(function (r) { result.capPlugin = { via: 'proxy', value: r }; }, function (e) { result.errors.push('Filesystem.getUri: ' + msg(e)); })
      .then(function () {
        result.ok = !!(result.trainStore && result.trainStore.value && result.trainStore.value.pong === 'gate0' && result.capPlugin && result.capPlugin.value && typeof result.capPlugin.value.uri === 'string' && result.isSecureContext && result.origin === 'capacitor://localhost' && result.errors.length === 0);
        return call('TrainStore', 'report', { json: JSON.stringify(result) }).catch(function (e) { note({ reportFailed: msg(e) }); });
      });
  }

  // --- the compare-and-swap save chain ---
  w.saveState = function (s) {
    if (!store.seeded) return Promise.resolve({ ignored: true });   // nothing before hydration
    var base = store.base, rev = base + 1, gen = store.generation;
    try { s._base = base; s._rev = rev; } catch (e) { /* a frozen object cannot be saved */ }
    store.base = rev;
    var json;
    try { json = JSON.stringify(s); } catch (e) { w.console.error('save failed', e); return Promise.resolve({ error: msg(e) }); }
    lsSet(STATE_KEY, json);
    if (store.refused) return Promise.resolve({ refused: true });
    return enqueueSave(base, json, gen);
  };
  function refusalText(reason) {
    var tail = ' This copy stops saving until the app relaunches. Export this screen’s copy from Settings if you need it.';
    if (reason === 'stale') return 'This copy fell behind the app’s saved data.' + tail;
    if (reason === 'generation') return 'The app’s store was replaced (an import, erase or recovery this screen did not see).' + tail;
    return 'The app’s store refused the last save (' + reason + ').' + tail;
  }
  function enqueueSave(base, json, gen) {
    store.pendingSaves++;
    var p = store.chain.then(function () {
      // a transaction in progress holds queued saves; once its generation bump lands they are superseded
      return store.txHold ? store.txHold : null;
    }).then(function () {
      if (gen !== store.generation) return { superseded: true };
      if (store.refused) return { refused: true };
      store.inflightSaves++;
      return call('TrainStore', 'save', { base: base, bytes: json, generation: gen }).then(function (r) {
        store.inflightSaves--;
        if (gen !== store.generation) return { superseded: true };          // a late ack from an older generation
        if (r && r.accepted) {
          store.rev = r.rev; store.lastCommitted = { rev: r.rev, bytes: json }; store.lastSaveFailed = false;
          return { accepted: true, rev: r.rev };
        }
        // a generation refusal with this page's generation unchanged is not one of our transactions: the
        // store was replaced by something this page did not see
        var reason = (r && r.reason) || 'refused';
        store.refused = true; store.lastSaveFailed = true;
        lsSet(REFUSED_KEY, '1');
        note({ refused: reason, base: base, fileRev: r && r.rev, fileGeneration: r && r.generation });
        showBanner(refusalText(reason));
        return { refused: true, reason: reason };
      }, function (e) {
        store.inflightSaves--;
        store.lastSaveFailed = true;
        note({ saveError: msg(e) });
        showBanner('A save did not reach the app’s store (' + msg(e) + '). Export your copy from Settings and relaunch.');
        return { error: msg(e) };
      });
    });
    var settled = p.then(function (r) { store.pendingSaves--; return r; }, function (e) { store.pendingSaves--; throw e; });
    store.chain = settled.catch(function () { /* keep the chain alive */ });
    return settled;
  }

  // --- transactions: Import and Erase ---
  // Disarm first: the guard blocks new sync starts, posts and re-arming; a request already in flight
  // settles; after 10 seconds the transaction aborts with a message and nothing changes. Saves are
  // not awaited: queued ones are held and then superseded by the generation bump; one already sent
  // settles in the plugin's queue before the transaction runs, and a stale base is read again.
  var txRelease = null;
  function beginTx() { store.txHold = new Promise(function (resolve) { txRelease = resolve; }); }
  function endTx() { var r = txRelease; txRelease = null; store.txHold = null; if (r) r(); }
  async function quiesce() {
    if (sync.quiescing) { note({ quiesceBusy: true }); return false; }   // one transaction at a time
    sync.quiescing = true;
    var idle = await waitFor(function () { return sync.inflight === 0; }, QUIESCE_MS);
    if (!idle) {
      sync.quiescing = false;
      note({ quiesceTimeout: true });
      w.showModal('Still syncing', 'A request is still in flight after 10 seconds. Nothing changed; try again in a moment.', [{ text: 'OK', cls: 'btn-primary', action: function () { w.hideModal(); } }]);
      return false;
    }
    beginTx();
    return true;
  }
  function abortTx() { sync.quiescing = false; endTx(); }
  function prepareImportBytes(data, base) {
    var copy = JSON.parse(JSON.stringify(data));
    var migrated = (typeof w.migrate === 'function') ? w.migrate(copy) : copy;
    if (!migrated) throw new Error('empty import');
    delete migrated._rev; delete migrated._base; delete migrated.seedRev;
    migrated._base = base; migrated._rev = base + 1;
    return JSON.stringify(migrated);
  }
  function refusedModal(title, text) {
    w.showModal(title, text, [{ text: 'OK', cls: 'btn-primary', action: function () { w.hideModal(); } }]);
  }
  // Native bumps the generation in its first control write, before the state write; a refusal after that
  // point reports the new generation with the old rev and data. Adopt it (queued saves are superseded)
  // and re-send this screen's copy from the file's rev, so nothing on screen stays uncommitted.
  function adoptGeneration(r) {
    if (!(r && typeof r.generation === 'number' && r.generation !== store.generation)) return false;
    seed(Number(r.rev) || 0, store.seedRev, r.generation);
    store.refused = false;
    note({ adoptedGeneration: r.generation, rev: store.rev });
    return true;
  }
  function resendLocal() {
    var cur = safeParse(localRaw());
    if (cur) { try { w.saveState(cur); } catch (e) { note({ resendFailed: msg(e) }); } }
  }
  w.importData = function (ev) {
    var f = ev && ev.target && ev.target.files && ev.target.files[0]; if (!f) return;
    var r = new w.FileReader();
    r.onload = function (e) {
      var data = safeParse(e.target.result);
      if (!data || !Array.isArray(data.log)) { w.alert(data ? 'Invalid backup file.' : 'Could not read file.'); return; }
      confirmImport(data);
    };
    r.readAsText(f);
  };
  function confirmImport(data) {
    var cur = safeParse(localRaw());
    var incoming = {}; (data.log || []).forEach(function (e) { if (e && e.sessionId) incoming[e.sessionId] = true; });
    var gone = ((cur && cur.log) || []).filter(function (e) { return e && e.sessionId && !incoming[e.sessionId]; });
    var text = 'Replace the data on this phone with ' + data.log.length + ' session' + (data.log.length === 1 ? '' : 's') + ' from the backup?';
    if (gone.length) text += ' ' + gone.length + ' session' + (gone.length === 1 ? '' : 's') + ' now on this phone ' + (gone.length === 1 ? 'is' : 'are') + ' not in it and would disappear: ' + gone.slice(0, 5).map(function (e) { return (e.date || '?') + ' ' + (e.sessionType || ''); }).join(', ') + (gone.length > 5 ? ' and more' : '') + '.';
    text += ' The current data is kept as a snapshot in the app’s store.';
    w.showModal('Import data?', text, [
      { text: 'Cancel', cls: 'btn-secondary', action: function () { w.hideModal(); } },
      { text: 'Import', cls: 'btn-primary', action: function () { w.hideModal(); runImport(data); } }
    ]);
  }
  async function runImport(data) {
    if (!(await quiesce())) return;
    try {
      var r = null, bytes = null;
      for (var attempt = 0; attempt < 3; attempt++) {
        var st = await call('TrainStore', 'status');
        var base = (st && st.rev) || 0;
        bytes = prepareImportBytes(data, base);
        r = await call('TrainStore', 'importState', { bytes: bytes, base: base });
        if (r && r.accepted) break;
        if (!(r && r.reason === 'stale')) break;      // a save already sent landed first: read the rev again
      }
      if (!(r && r.accepted)) {
        var adopted = adoptGeneration(r);
        abortTx();
        if (adopted) resendLocal();
        note({ importRefused: r && r.reason });
        refusedModal('Import did not happen', 'The app refused it (' + ((r && r.reason) || 'unknown') + '). Nothing changed; try again.');
        return;
      }
      store.generation = r.generation;          // queued saves from before this are superseded
      lsSet(STATE_KEY, bytes);
      lsDel(SNAP_KEY); store.snapshot = null;
      seed(r.rev, r.rev, r.generation);
      store.lastCommitted = { rev: r.rev, bytes: bytes }; store.refused = false; store.lastSaveFailed = false;
      note({ imported: r.rev, generation: r.generation });
      endTx();
      w.location.reload();
    } catch (e) {
      abortTx();
      note({ importError: msg(e) });
      refusedModal('Import did not happen', msg(e) + '. Nothing changed.');
    }
  }
  w.confirmErase = function () {
    w.showModal('Erase all data?', 'Permanently deletes all sessions, promotions and progression on this phone. The app keeps a snapshot for a while, but there is no undo here.', [
      { text: 'Cancel', cls: 'btn-secondary', action: function () { w.hideModal(); } },
      { text: 'Erase everything', cls: 'btn-danger', action: function () { w.hideModal(); runErase(); } }
    ]);
  };
  async function runErase() {
    if (!(await quiesce())) return;
    try {
      var r = await call('TrainStore', 'erase');
      if (!(r && r.accepted)) {
        var adopted = adoptGeneration(r);
        abortTx();
        if (adopted) resendLocal();
        note({ eraseRefused: r && r.reason });
        refusedModal('Erase did not happen', 'The app refused it (' + ((r && r.reason) || 'unknown') + '). Nothing changed.');
        return;
      }
      store.generation = r.generation;
      lsDel(STATE_KEY); lsDel(SNAP_KEY); store.snapshot = null;
      seed(0, 0, r.generation);
      store.lastCommitted = null; store.refused = false; store.lastSaveFailed = false;
      note({ erased: true, generation: r.generation });
      endTx();
      w.location.reload();
    } catch (e) {
      abortTx();
      refusedModal('Erase did not happen', msg(e) + '. Nothing changed.');
    }
  }

  // --- Export: a consistency boundary ---
  function stripForExport(bytes) {
    var o = JSON.parse(bytes); delete o._rev; delete o._base; delete o.seedRev;
    return JSON.stringify(o, null, 2);
  }
  async function writeExport(name, bytes) {
    var r = await call('Filesystem', 'writeFile', { path: name, data: stripForExport(bytes), directory: 'CACHE', encoding: 'utf8', recursive: true });
    return r && r.uri;
  }
  function isCancel(e) { return /cancel/i.test(msg(e)) || (e && e.name === 'AbortError'); }
  function dayStamp() { return (typeof w.localDay === 'function') ? w.localDay() : new Date().toISOString().slice(0, 10); }
  w.exportData = async function () {
    var settledInTime = await waitFor(function () { return store.pendingSaves === 0; }, EXPORT_WAIT_MS);
    var files = [];
    try {
      if (settledInTime && !store.lastSaveFailed && !store.refused && store.lastCommitted) {
        files.push(await writeExport('train-backup-' + dayStamp() + '.json', store.lastCommitted.bytes));
      } else {
        if (store.lastCommitted) files.push(await writeExport('train-backup-' + dayStamp() + '-committed.json', store.lastCommitted.bytes));
        var cand = localRaw();
        if (cand) files.push(await writeExport('train-backup-' + dayStamp() + '-candidate.json', cand));
        showBanner(settledInTime
          ? 'The last save was not confirmed, so two files were exported: the app’s saved copy and this screen’s copy.'
          : 'A save was still pending after 3 seconds, so two files were exported: the app’s saved copy and this screen’s copy.');
      }
      note({ exported: files.length, settledInTime: settledInTime });
      if (!files.length) { w.alert('Nothing to export yet.'); return; }
      await call('Share', 'share', { title: 'Train backup', files: files });
    } catch (e) {
      if (isCancel(e)) return;
      refusedModal('Could not export', msg(e));
    }
  };
  async function exportSnapshot() {
    var snap = store.snapshot || safeParse(lsGet(SNAP_KEY));
    if (!snap || !snap.bytes) { w.alert('No snapshot is kept right now.'); return; }
    try {
      var uri = await writeExport('train-snapshot-' + dayStamp() + '.json', snap.bytes);
      await call('Share', 'share', { title: 'Train snapshot', files: [uri] });
    } catch (e) { if (!isCancel(e)) refusedModal('Could not export the snapshot', msg(e)); }
  }
  w.__exportSnapshot = exportSnapshot;

  // --- Settings: the store line and the snapshot row ---
  var origRenderSettings = w.renderSettings;
  w.renderSettings = function () {
    if (typeof origRenderSettings === 'function') origRenderSettings.apply(this, arguments);
    appendStoreCard();
  };
  function appendStoreCard() {
    var c = w.document.getElementById('settings-content'); if (!c) return;
    var card = w.document.createElement('div');
    card.id = 'store-card'; card.className = 'card'; card.setAttribute('style', 'margin-top:12px;');
    card.innerHTML = '<div style="font-weight:700;margin-bottom:6px;">App store</div>'
      + '<div id="store-status" style="font-size:12px;color:var(--text2);">Store: reading…</div>'
      + '<div id="store-loaded" style="font-size:12px;color:var(--text3);margin-top:4px;"></div>'
      + (store.snapshot ? '<div class="setting-row" style="margin-top:8px;"><div><div style="font-weight:600;">Saved snapshot</div><div id="store-snapshot-line" style="font-size:12px;color:var(--text2);">…</div></div><button id="store-snapshot-export" class="btn btn-small btn-secondary">Export the saved snapshot</button></div>' : '')
      + ((store.launch && store.launch.uiTest) ? '<div class="setting-row" style="margin-top:8px;"><div style="font-weight:600;">Embed test</div><button id="store-embed-test" class="btn btn-small btn-secondary">Embed test</button></div>' : '');
    c.appendChild(card);
    if (store.launch && store.launch.uiTest) el('store-embed-test', 'button').onclick = function () { startEmbedTest(); };
    call('TrainStore', 'status').then(function (st) {
      el('store-status').textContent = 'Store: rev ' + (st.rev || 0) + (st.committedAt ? ' committed ' + hhmm(st.committedAt) : ' (nothing committed yet)') + ' · generation ' + (st.generation || 0) + (store.refused ? ' · this copy is behind' : '');
    }, function (e) { el('store-status').textContent = 'Store: unavailable (' + msg(e) + ')'; });
    var loaded = safeParse(localRaw());
    if (loaded) digestOf(loaded).then(function (d) { var n = sessionIds(loaded).length; el('store-loaded').textContent = n + ' session' + (n === 1 ? '' : 's') + ' loaded · digest ' + d; }).catch(function () {});
    if (store.snapshot) {
      describeSnapshot(store.snapshot).then(function (d) { el('store-snapshot-line').textContent = d + ' · kept ' + hhmm(store.snapshot.at); });
      el('store-snapshot-export', 'button').onclick = function () { exportSnapshot(); };
    }
  }

  // ====================================================================================================
  // Parity (build order 3 and 4)
  // ====================================================================================================

  // --- test notes: bridge-side state the CI UI tests read through the native summary (uiTest launches only)
  function testNote(obj) {
    if (!(store.launch && store.launch.uiTest)) return Promise.resolve();
    return call('TrainStore', 'testNote', { json: JSON.stringify(obj) }).catch(function () {});
  }

  // --- navigator.wakeLock over the native idle timer ---
  // The app's PT list calls navigator.wakeLock.request('screen') and keeps the sentinel until a 'release'
  // event (ptWakeOn re-acquires only after one). Native owns UIApplication.isIdleTimerDisabled with a
  // generation token; it releases on background and tells this page, and this page releases on hidden,
  // pagehide and hydration, dispatching 'release' to every sentinel it held.
  var wake = w.__wake = { sentinels: [], listener: null };
  function makeSentinel(token) {
    var listeners = [];
    var s = { type: 'screen', released: false, onrelease: null, __token: token };
    s.addEventListener = function (type, fn) { if (type === 'release' && typeof fn === 'function') listeners.push(fn); };
    s.removeEventListener = function (type, fn) { listeners = listeners.filter(function (f) { return f !== fn; }); };
    s.release = function () { return releaseSentinel(s); };
    s.__dispatch = function () {
      if (s.released) return;
      s.released = true;
      wake.sentinels = wake.sentinels.filter(function (x) { return x !== s; });
      var ev = { type: 'release', target: s };
      listeners.slice().forEach(function (fn) { try { fn(ev); } catch (e) { logLine('error', ['wakeLock release listener', e]); } });
      if (typeof s.onrelease === 'function') { try { s.onrelease(ev); } catch (e) { logLine('error', ['wakeLock onrelease', e]); } }
    };
    return s;
  }
  function releaseSentinel(s) {
    if (s.released) return Promise.resolve();
    s.__dispatch();
    note({ wakeRelease: s.__token });
    return call('TrainStore', 'wakeRelease', { token: s.__token }).then(function () {}, function (e) { note({ wakeReleaseFailed: msg(e) }); });
  }
  function releaseAllSentinels(why) {
    var held = wake.sentinels.slice();
    held.forEach(function (s) { s.__dispatch(); });
    if (held.length) note({ wakeReleasedAll: why, count: held.length });
    if (!held.length && why !== 'hydration') return Promise.resolve();
    return call('TrainStore', 'wakeRelease', {}).then(function () {}, function (e) { note({ wakeReleaseFailed: msg(e) }); });
  }
  function requestWakeLock(type) {
    if (type !== 'screen') return Promise.reject(new TypeError('only screen wake locks are supported'));
    if (w.document.visibilityState === 'hidden') return Promise.reject(new Error('NotAllowedError: the document is hidden'));
    return call('TrainStore', 'wakeAcquire').then(function (r) {
      if (!r || !r.ok) throw new Error('wake lock refused');
      var s = makeSentinel(r.token);
      wake.sentinels.push(s);
      note({ wakeAcquire: r.token });
      return s;
    });
  }
  try {
    Object.defineProperty(w.navigator, 'wakeLock', { configurable: true, enumerable: true, value: { request: requestWakeLock } });
  } catch (e) { logLine('error', ['wakeLock polyfill not installed', e]); }
  if (w.document && typeof w.document.addEventListener === 'function') {
    // the app's own visibilitychange handler was registered first; it re-acquires on 'visible' once its sentinel is released
    w.document.addEventListener('visibilitychange', function () { if (w.document.visibilityState === 'hidden') releaseAllSentinels('hidden'); });
  }
  if (typeof w.addEventListener === 'function') w.addEventListener('pagehide', function () { releaseAllSentinels('pagehide'); });
  function onNativeWakeReleased(ev) {
    var held = wake.sentinels.length > 0;
    wake.sentinels.slice().forEach(function (s) { s.__dispatch(); });
    note({ nativeWakeReleased: ev && ev.token, reason: ev && ev.reason, held: held });
    // a release this page had not seen (the hidden event did not run before suspension): give the app its re-acquire
    if (held && w.document.visibilityState === 'visible' && typeof w.ptWakeOn === 'function') { try { w.ptWakeOn(); } catch (e) { logLine('error', ['ptWakeOn', e]); } }
  }
  (function listenNativeWake() {
    var p = pl('TrainStore');
    if (!p || typeof p.addListener !== 'function') { wake.listener = 'none'; return; }
    try { p.addListener('wakeReleased', onNativeWakeReleased); wake.listener = 'plugin'; } catch (e) { wake.listener = 'error:' + msg(e); }
  })();

  // --- one audio path: the six cues play natively (audio plus haptic), gated like toneW and buzz ---
  var CUES = {
    cueGo: ['notification', 'SUCCESS'], cueRelease: ['notification', 'WARNING'], cueStarted: ['impact', 'LIGHT'],
    cueLogged: ['impact', 'LIGHT'], cueSessionDone: ['notification', 'SUCCESS'], cueNoted: ['impact', 'MEDIUM']
  };
  function soundOn() { try { return typeof w.soundEnabled === 'function' ? !!w.soundEnabled() : true; } catch (e) { return true; } }
  function playCue(name) {
    if (!soundOn()) return Promise.resolve({ muted: true });
    var h = CUES[name];
    var haptic = h[0] === 'impact' ? call('Haptics', 'impact', { style: h[1] }) : call('Haptics', 'notification', { type: h[1] });
    haptic.catch(function (e) { note({ hapticFailed: name, error: msg(e) }); });
    return call('TrainStore', 'cue', { name: name }).then(function (r) { return r; }, function (e) { note({ cueFailed: name, error: msg(e) }); return { error: msg(e) }; });
  }
  Object.keys(CUES).forEach(function (name) { w[name] = function () { return playCue(name); }; });
  w.unlockAudio = function () {};
  w.toneW = function () {};

  // --- the sound key rides in the store's control sidecar (not state, so not in an export) ---
  function hydrateSoundKey(res) {
    var fileOff = res && (res.soundOff === true || res.soundOff === false) ? res.soundOff : null;
    var local = lsGet(SOUND_KEY);
    if (fileOff !== null) { lsSet(SOUND_KEY, fileOff ? '1' : '0'); return; }          // the store's copy survives eviction
    if (local === '1' || local === '0') call('TrainStore', 'setSoundOff', { off: local === '1' }).catch(function () {});
  }
  var origSetSoundEnabled = w.setSoundEnabled;
  w.setSoundEnabled = function (on) {
    if (typeof origSetSoundEnabled === 'function') origSetSoundEnabled(on);
    call('TrainStore', 'setSoundOff', { off: !on }).catch(function (e) { note({ soundSaveFailed: msg(e) }); });
  };

  // --- embeds: YouTube through the https wrapper on Pages, which has a Referer to send ---
  var origBuildEmbedUrl = w.buildEmbedUrl;
  w.buildEmbedUrl = function (ref) {
    if (!ref || !ref.videoId) return null;
    if (ref.mediaType === 'youtube') {
      var u = EMBED_BASE + '?yt=' + encodeURIComponent(ref.videoId);
      if (ref.start) u += '&start=' + encodeURIComponent(ref.start);
      if (ref.end) u += '&end=' + encodeURIComponent(ref.end);
      return u;
    }
    return typeof origBuildEmbedUrl === 'function' ? origBuildEmbedUrl(ref) : null;
  };
  if (typeof w.addEventListener === 'function') {
    w.addEventListener('message', function (ev) {
      var d = ev && ev.data;
      if (!d || d.type !== 'train-embed') return;
      store.embed = Object.assign(store.embed || {}, { id: d.id, state: d.state, code: d.code == null ? undefined : d.code, origin: ev.origin, at: new Date().toISOString() });
      note({ embed: d.state, code: d.code, id: d.id });
      testNote({ embed: store.embed });
    });
  }
  // uiTest only: opens the reference modal on a known public video and reports the wrapper's reachability
  // (it lives on Pages, so a branch build may find it missing) and the player's state.
  function startEmbedTest() {
    store.embed = { id: EMBED_TEST_ID, state: 'opening', url: w.buildEmbedUrl({ mediaType: 'youtube', videoId: EMBED_TEST_ID }) };
    testNote({ embed: store.embed });
    w.fetch(EMBED_BASE, { cache: 'no-store' }).then(function (r) { store.embed.wrapper = r.status; }, function (e) { store.embed.wrapper = 'fetch:' + msg(e); }).then(function () { testNote({ embed: store.embed }); });
    if (typeof w.showRefFor === 'function') w.showRefFor('Embed test', { status: 'video', mediaType: 'youtube', videoId: EMBED_TEST_ID, fallbackUrl: 'https://www.youtube.com/watch?v=' + EMBED_TEST_ID, sourceLabel: 'YouTube' }, 'Embed test: the player reports ready through the wrapper.');
    w.setTimeout(function () { if (store.embed && (store.embed.state === 'opening' || store.embed.state === 'loaded')) { store.embed.state = 'timeout:' + store.embed.state; testNote({ embed: store.embed }); } }, EMBED_TIMEOUT_MS);
  }
  w.__startEmbedTest = startEmbedTest;

  // restore a kept snapshot's record across reloads (the bytes stay in localStorage)
  store.snapshot = safeParse(lsGet(SNAP_KEY));
})(window);
