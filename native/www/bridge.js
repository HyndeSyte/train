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
//     sidecar; buildEmbedUrl points YouTube embeds at the https wrapper page on Pages;
//   - the cutover build (plan section 5): sync is off until the native "Start syncing from this app"
//     switch is on (syncArmed in the control sidecar); armed, the three sync functions are serializing
//     wrappers over the shell's own fetch with X-Train-Client: native, a 403 ends the drain; Settings
//     shows the loaded state's count and digest and, after an Import, "verified" (fingerprint plus
//     synced flags, persisted in the sidecar and recomputed on boot); the tombstone probe and the
//     forced-failure hooks exist only in Debug builds launched with -trainUITest.
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

  // --- sync: off (no-ops) until the native switch arms it; the guard holds in both states ---
  // The originals are kept for reference; the shell's own fetch is the window's original fetch, bound
  // before anything could patch it, so a post carries Origin: capacitor://localhost and a real preflight.
  var origFetch = typeof w.fetch === 'function' ? w.fetch.bind(w) : null;
  var origSync = { pushUnsynced: w.pushUnsynced, syncEntry: w.syncEntry, postSync: w.postSync };
  var SYNC_URL = (typeof SYNC_ENDPOINT === 'string') ? SYNC_ENDPOINT : 'https://hyndesyte-train-sync.netlify.app/.netlify/functions/sync-training-session';
  var SYNC_REFUSED_TEXT = 'sync refused: this app is not the writer; use Sync now once the hand-off is done';
  var sync = w.__sync = { inflight: 0, quiescing: false, armed: false, chain: Promise.resolve(), refused: null, posts: 0, drains: 0, lastStatus: null };
  function syncRefused() { note({ syncRefused: 'quiescing' }); return { refused: 'quiescing' }; }
  function offPushUnsynced() { if (sync.quiescing) return Promise.resolve(syncRefused()); note({ syncSkipped: 'off' }); return Promise.resolve({ off: true }); }
  function offSyncEntry() { if (sync.quiescing) return Promise.resolve(syncRefused()); return Promise.resolve({ off: true }); }
  function offPostSync() { if (sync.quiescing) { syncRefused(); return Promise.reject(new Error('sync is quiescing')); } var e = new Error('sync is off in the shell'); e.off = true; return Promise.reject(e); }
  function installSync(armed) {
    sync.armed = !!armed;
    if (!sync.armed) { w.pushUnsynced = offPushUnsynced; w.syncEntry = offSyncEntry; w.postSync = offPostSync; return; }
    w.pushUnsynced = shellPushUnsynced; w.syncEntry = shellSyncEntry; w.postSync = shellPostSync;
  }
  installSync(false);

  var store = w.__store = {
    seeded: false, base: 0, rev: 0, seedRev: 0, generation: null,
    refused: false, pendingSaves: 0, inflightSaves: 0, lastSaveFailed: false, lastCommitted: null,
    chain: Promise.resolve(), txHold: null, snapshot: null, banner: null, hydrated: false, readyPromise: null, events: [], logRing: [],
    launch: null, embed: null,
    config: { readRetryMs: READ_RETRY_MS, quiesceMs: QUIESCE_MS, exportWaitMs: EXPORT_WAIT_MS }, embedTimeoutMs: EMBED_TIMEOUT_MS
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
    noteSnapshot(snap);
    return describeSnapshot(snap).then(function (d) {
      showBanner('Loaded the app’s saved copy (rev ' + file.rev + '). This screen’s previous copy (' + d + ') is kept as a snapshot: Settings → Export the saved snapshot.', { snapshot: true });
    });
  }
  // the loaded state's count and digest, cached whenever the local copy changes: Settings patches its own
  // markup with it synchronously, before the store card (whose buttons carry JS handlers) is appended
  function refreshLoadedLine() {
    var loaded = safeParse(localRaw());
    if (!loaded) { store.loadedLine = null; return Promise.resolve(null); }
    var n = sessionIds(loaded).length;
    return digestOf(loaded).then(function (d) { store.loadedLine = { n: n, digest: d, text: n + ' session' + (n === 1 ? '' : 's') + ' · digest ' + d }; return store.loadedLine; }, function () { store.loadedLine = { n: n, digest: null, text: n + ' session' + (n === 1 ? '' : 's') }; return store.loadedLine; });
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
    installSync(!!(res && res.syncArmed === true));          // the switch's persisted value decides whether this run posts
    store.verifiedRecord = (res && res.verified && typeof res.verified === 'object') ? res.verified : null;
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
    if (r && r.accepted) await recordVerification(bytes, r.rev);   // the smoke asserts "verified" through the same path as a real Import
  }

  w.__trainReady = function () {
    if (!store.readyPromise) {
      showLoading('Loading your saved data…');          // cover the nav from the first IPC
      store.readyPromise = (async function () {
        releaseAllSentinels('hydration');                // a reload never inherits an idle-timer hold
        try { await maybeImportFixture(); } catch (e) { note({ fixtureFailed: msg(e), stack: String(e && e.stack || '').slice(0, 300) }); }
        await hydrate();
        await refreshLoadedLine();
        store.hydrated = true;
        hideLoading();
        checkVerified().catch(function (e) { note({ verifiedCheckFailed: msg(e) }); });
        reportGate0();
        if (store.launch && store.launch.probeTombstone) runTombstoneProbe();
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
          noteLocal();
          refreshLoadedLine();
          return { accepted: true, rev: r.rev };
        }
        // a generation refusal with this page's generation unchanged is not one of our transactions: the
        // store was replaced by something this page did not see
        var reason = (r && r.reason) || 'refused';
        store.refused = true; store.lastSaveFailed = true;
        // the marker says "this page's lineage is not the file's": a stale base, a replaced store or
        // bytes the store could not read. A failed write (disk) leaves the lineage intact, so the next
        // launch writes the local copy through, and a disk that still fails lands in keep-both there.
        if (reason === 'stale' || reason === 'generation' || reason === 'invalid') lsSet(REFUSED_KEY, '1');
        note({ refused: reason, base: base, fileRev: r && r.rev, fileGeneration: r && r.generation });
        noteLocal();
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
      reinstallFromStatus();
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
        await reinstallFromStatus();               // the first control write may have disarmed the store
        if (adopted) resendLocal();
        note({ importRefused: r && r.reason });
        refusedModal('Import did not happen', 'The app refused it (' + ((r && r.reason) || 'unknown') + '). Nothing changed; try again.');
        return;
      }
      await recordVerification(bytes, r.rev);    // what the committed state must match after the reload and later kills
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
      reinstallFromStatus();
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
        await reinstallFromStatus();
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
      reinstallFromStatus();
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
  var SILENT_LINE_PWA = 'Audio cues only play when your phone\'s silent switch is off.';
  var SILENT_LINE_SHELL = 'Cues play with the silent switch on; turn Cue sounds off to silence them.';
  var origRenderSettings = w.renderSettings;
  w.renderSettings = function () {
    if (typeof origRenderSettings === 'function') origRenderSettings.apply(this, arguments);
    fixSilentSwitchLine();
    appendStoreCard();
  };
  // the shell's cues use the playback category (ducking needs it), so they sound with the silent switch on
  function fixSilentSwitchLine() {
    var c = w.document.getElementById('settings-content'); if (!c) return;
    var html = c.innerHTML;
    if (html && html.indexOf(SILENT_LINE_PWA) !== -1) c.innerHTML = html.split(SILENT_LINE_PWA).join(SILENT_LINE_SHELL);
  }
  function appendStoreCard() {
    var c = w.document.getElementById('settings-content'); if (!c) return;
    // the app's own markup is patched as a string BEFORE the card is appended (a later rewrite of the
    // container would re-create the card's buttons without their handlers): the count and digest beside
    // Export, and Retry sync routed to Sync now (an explicit drain, see shellPushUnsynced)
    var exportLine = 'Full log as JSON, via the share sheet';
    var html = c.innerHTML || '';
    if (store.loadedLine && html.indexOf(exportLine) !== -1) html = html.split(exportLine).join(exportLine + ' · ' + store.loadedLine.text);
    html = html.split('onclick="pushUnsynced()"').join('onclick="__syncNow()"');
    if (html !== c.innerHTML) c.innerHTML = html;
    var card = w.document.createElement('div');
    card.id = 'store-card'; card.className = 'card'; card.setAttribute('style', 'margin-top:12px;');
    card.innerHTML = '<div style="font-weight:700;margin-bottom:6px;">App store</div>'
      + '<div id="store-status" style="font-size:12px;color:var(--text2);">Store: reading…</div>'
      + '<div id="store-loaded" style="font-size:12px;color:var(--text3);margin-top:4px;"></div>'
      + '<div id="store-verified" style="font-size:12px;color:var(--text3);margin-top:4px;"></div>'
      + (store.snapshot ? '<div class="setting-row" style="margin-top:8px;"><div><div style="font-weight:600;">Saved snapshot</div><div id="store-snapshot-line" style="font-size:12px;color:var(--text2);">…</div></div><button id="store-snapshot-export" class="btn btn-small btn-secondary" onclick="__exportSnapshot()">Export the saved snapshot</button></div>' : '')
      + '<div class="setting-row" style="margin-top:8px;"><div><div style="font-weight:600;">Start syncing from this app</div><div id="store-sync-line" style="font-size:12px;color:var(--text2);">Off until the hand-off is done.</div></div><button id="store-sync-switch" class="btn btn-small btn-secondary" aria-label="Start syncing from this app" onclick="__toggleSyncArmed()">…</button></div>'
      + '<div class="setting-row"><div><div style="font-weight:600;">Sync now</div><div style="font-size:12px;color:var(--text2);">Drains pending sessions and deletes with the current switch.</div></div><button id="store-sync-now" class="btn btn-small btn-secondary" onclick="__syncNow()">Sync now</button></div>'
      + ((store.launch && store.launch.uiTest) ? '<div class="setting-row" style="margin-top:8px;"><div style="font-weight:600;">Embed test</div><button id="store-embed-test" class="btn btn-small btn-secondary" onclick="__startEmbedTest()">Embed test</button></div>' : '');
    // the buttons carry inline onclick attributes to globals (like the app's own), so they survive any
    // re-parse of the container; the property handlers below serve the Node harness
    c.appendChild(card);
    if (store.launch && store.launch.uiTest) el('store-embed-test', 'button').onclick = function () { startEmbedTest(); };
    el('store-sync-switch', 'button').onclick = function () { toggleSyncArmed(); };
    el('store-sync-now', 'button').onclick = function () { syncNow(); };
    renderSyncSwitch(sync.armed);
    call('TrainStore', 'status').then(function (st) {
      el('store-status').textContent = 'Store: rev ' + (st.rev || 0) + (st.committedAt ? ' committed ' + hhmm(st.committedAt) : ' (nothing committed yet)') + ' · generation ' + (st.generation || 0) + (store.refused ? ' · this copy is behind' : '');
      renderSyncSwitch(st.syncArmed === true);
    }, function (e) { el('store-status').textContent = 'Store: unavailable (' + msg(e) + ')'; });
    if (store.loadedLine) el('store-loaded').textContent = store.loadedLine.text + ' loaded';
    else refreshLoadedLine().then(function (l) { if (l) el('store-loaded').textContent = l.text + ' loaded'; });
    renderVerified();
    if (store.snapshot) {
      describeSnapshot(store.snapshot).then(function (d) { el('store-snapshot-line').textContent = d + ' · kept ' + hhmm(store.snapshot.at); });
      el('store-snapshot-export', 'button').onclick = function () { exportSnapshot(); };
    }
  }

  // ====================================================================================================
  // Cutover build (plan section 5): sync arming, verified, the drill hooks, the tombstone probe
  // ====================================================================================================

  // --- armed sync: one chain, one request in flight, the quiescing guard honoured ---
  function enqueueSync(fn) {
    var p = sync.chain.then(fn);
    sync.chain = p.catch(function () {});
    return p;
  }
  // the plugin's live syncArmed is asked for before every request (one IPC): a transaction that disarmed
  // the store, even one that then failed, stops this page's posts at once
  function liveArmed() {
    return call('TrainStore', 'status').then(function (st) {
      var armed = !!(st && st.syncArmed === true);
      if (!armed && sync.armed) { installSync(false); note({ syncDisarmedLive: true }); }
      return armed;
    }, function (e) { note({ syncStatusFailed: msg(e) }); return false; });
  }
  function offError() { var e = new Error('sync is off in the shell'); e.off = true; return e; }
  function shellPostSync(body) {
    if (sync.quiescing) { syncRefused(); return Promise.reject(new Error('sync is quiescing')); }
    if (!sync.armed) return Promise.reject(offError());
    if (!origFetch) return Promise.reject(new Error('no fetch in this web view'));
    return liveArmed().then(function (armed) {
      if (!armed) throw offError();
      return postArmed(body);
    });
  }
  function postArmed(body) {
    sync.inflight++; sync.posts++;
    var done = function () { sync.inflight--; };
    return origFetch(SYNC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Train-Client': 'native' }, body: JSON.stringify(body) }).then(function (res) {
      sync.lastStatus = res.status;
      if (res.status === 403) {
        // not the writer: terminal for this drain; the entry stays pending and nothing re-posts until Sync now
        return res.text().then(function (text) {
          sync.refused = { at: new Date().toISOString(), status: 403, body: String(text || '').slice(0, 300) };
          note({ syncRefused403: sync.refused.body });
          showBanner(SYNC_REFUSED_TEXT);
          var e = new Error(SYNC_REFUSED_TEXT); e.terminal = true; e.status = 403; throw e;
        });
      }
      if (res.status === 503) { var e5 = new Error('sync 503'); e5.status = 503; e5.retry = true; throw e5; }   // a plain retry later
      if (!res.ok) { var eo = new Error('sync ' + res.status); eo.status = res.status; throw eo; }               // the app's own handling
      return res.json();
    }).then(function (r) { done(); return r; }, function (e) { done(); throw e; });
  }
  // one entry, the app's syncEntry with one difference: a terminal refusal leaves the entry pending
  async function syncOne(sessionId) {
    var s = w.getState();
    var entry = (s.log || []).find(function (x) { return x.sessionId === sessionId; });
    if (!entry) return { missing: true };
    w.markSync(sessionId, { status: 'pending', lastAttemptAt: new Date().toISOString(), error: null });
    w.refreshSyncIndicator();
    try {
      var data = await w.postSync(w.buildSyncPayload(entry));
      w.markSync(sessionId, { status: 'synced', syncedAt: new Date().toISOString(), notionPageId: (data && data.notionPageId) || null, error: null });
      w.refreshSyncIndicator();
      return { synced: true };
    } catch (e) {
      // a terminal refusal and "off" leave the entry pending; other errors are failures, as in the app
      w.markSync(sessionId, { status: (e && (e.terminal || e.off)) ? 'pending' : 'failed', error: msg(e) });
      w.refreshSyncIndicator();
      return { failed: true, terminal: !!(e && e.terminal), off: !!(e && e.off), status: e && e.status };
    }
  }
  async function drain() {
    sync.refused = null; sync.drains++;
    var posted = 0, stopped = null;
    var s = w.getState();
    var deletes = Array.isArray(s.pendingDeletes) ? s.pendingDeletes.slice() : [];
    for (var i = 0; i < deletes.length; i++) {
      if (!sync.armed) { stopped = 'off'; break; }
      if (sync.quiescing) { stopped = 'quiescing'; break; }
      if (sync.refused) { stopped = 'refused'; break; }
      try {
        await w.postSync({ op: 'delete', sessionId: deletes[i] });
        var cur = w.getState(); cur.pendingDeletes = (cur.pendingDeletes || []).filter(function (x) { return x !== deletes[i]; }); w.saveState(cur);
        posted++;
      } catch (e) {
        if (e && e.terminal) { stopped = 'refused'; break; }
        if (e && e.off) { stopped = 'off'; break; }
      }
    }
    if (!stopped) {
      s = w.getState();
      var pending = (s.log || []).filter(function (e) { return e.sessionId && (!e.notionSync || e.notionSync.status !== 'synced'); })
        .sort(function (a, b) { return (a.sessionSequence || 0) - (b.sessionSequence || 0); });
      for (var j = 0; j < pending.length; j++) {
        if (!sync.armed) { stopped = 'off'; break; }
        if (sync.quiescing) { stopped = 'quiescing'; break; }
        if (sync.refused) { stopped = 'refused'; break; }
        var r = await syncOne(pending[j].sessionId);
        if (r && r.synced) posted++;
        if (r && r.terminal) { stopped = 'refused'; break; }
        if (r && r.off) { stopped = 'off'; break; }
      }
    }
    w.refreshSyncIndicator();
    note({ drained: posted, stopped: stopped });
    return { posted: posted, stopped: stopped };
  }
  // the app's own calls (boot, a History delete, a finalize) never re-post after a refusal; Sync now (and
  // the Retry button, routed to it) starts a fresh drain
  function shellPushUnsynced() {
    if (sync.quiescing) return Promise.resolve(syncRefused());
    if (sync.refused) { note({ syncSkipped: 'refused' }); return Promise.resolve({ skipped: 'refused' }); }
    return enqueueSync(drain);
  }
  function shellSyncEntry(sessionId) {
    if (sync.quiescing) return Promise.resolve(syncRefused());
    return enqueueSync(function () {
      if (!sync.armed) return { skipped: 'off' };
      if (sync.quiescing) return syncRefused();
      if (sync.refused) { note({ syncSkipped: 'refused', sessionId: sessionId }); return { skipped: 'refused' }; }   // nothing re-posts until Sync now
      return syncOne(sessionId);
    });
  }

  // --- the switch ---
  function renderSyncSwitch(armed) {
    var b = w.document.getElementById('store-sync-switch'); if (!b) return;
    b.textContent = armed ? 'On' : 'Off';
    b.className = 'btn btn-small ' + (armed ? 'btn-primary' : 'btn-secondary');
    var line = w.document.getElementById('store-sync-line');
    if (line) line.textContent = armed ? 'This app posts its sessions to the mirror.' : 'Off until the hand-off is done.';
  }
  function setSyncArmed(on) {
    if (on && sync.quiescing) { refusedModal('A change is in progress', 'Import or Erase is still running. Try again in a moment; nothing changed.'); return Promise.resolve(sync.armed); }
    if (!on) installSync(false);                    // off takes effect at once, before the round trip
    return call('TrainStore', 'setSyncArmed', { on: !!on }).then(function (r) {
      var armed = !!(r && r.ok && r.syncArmed === true);
      installSync(armed);
      note({ syncArmed: armed });
      if (on && !armed) refusedModal('Could not turn syncing on', 'The app did not keep the setting. Nothing changed.');
      if (typeof w.renderSettings === 'function') w.renderSettings();
      return armed;
    }, function (e) { refusedModal('Could not change syncing', msg(e)); return sync.armed; });
  }
  function toggleSyncArmed() {
    if (sync.armed) { setSyncArmed(false); return; }   // turning off needs no confirm
    w.showModal('Start syncing from this app?', 'Only after the hand-off: the PWA is switched off and the mirror names this app as the writer. Until then the mirror refuses this app’s posts. Turn it on now?', [
      { text: 'Cancel', cls: 'btn-secondary', action: function () { w.hideModal(); } },
      { text: 'Turn on', cls: 'btn-primary', action: function () { w.hideModal(); setSyncArmed(true); } }
    ]);
  }
  function syncNow() {
    if (!sync.armed) { refusedModal('Syncing is off', 'Turn on “Start syncing from this app” first; nothing was sent.'); return Promise.resolve({ off: true }); }
    if (sync.quiescing) return Promise.resolve(syncRefused());
    return enqueueSync(drain);                     // explicit: a fresh drain, past any earlier refusal
  }
  // after a transaction (succeeded, failed or aborted) the sidecar's switch is what counts
  function reinstallFromStatus() {
    return call('TrainStore', 'status').then(function (st) { installSync(!!(st && st.syncArmed === true)); return sync.armed; }, function () { installSync(false); return false; });
  }
  w.__setSyncArmed = setSyncArmed;
  w.__toggleSyncArmed = toggleSyncArmed;
  w.__syncNow = syncNow;

  // --- the fingerprint and "verified" ---
  // SHA-256 of canonical JSON (keys sorted, compact) of the state after migrate(): every log entry minus
  // notionSync, plus the listed top-level keys; _rev, _base, seedRev and every notionSync are outside it.
  var FP_KEYS = ['pendingDeletes', 'rotationIndex', 'nextSessionOverride', 'nextSessionSequence', 'anchorProgress', 'legacy', 'activeSession', 'recovery', 'armCheck', 'ptLevels', 'schemaVersion', 'progressionEngineVersion'];
  function canonical(v) {
    if (v === undefined || v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (typeof v === 'object') return '{' + Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort().map(function (k) { return JSON.stringify(k) + ':' + canonical(v[k]); }).join(',') + '}';
    return JSON.stringify(null);
  }
  function fingerprintObject(state) {
    var o = {};
    FP_KEYS.forEach(function (k) { o[k] = state[k] === undefined ? null : state[k]; });
    o.log = (state.log || []).map(function (e) { if (!e || typeof e !== 'object') return e; var c = Object.assign({}, e); delete c.notionSync; return c; });
    return o;
  }
  function migratedCopy(state) {
    var copy = JSON.parse(JSON.stringify(state));
    try { return (typeof w.migrate === 'function') ? (w.migrate(copy) || copy) : copy; } catch (e) { return copy; }
  }
  function fingerprintOf(state) { return sha256Hex(canonical(fingerprintObject(migratedCopy(state)))); }
  function syncedIdsOf(state) { return (state.log || []).filter(function (e) { return e && e.notionSync && e.notionSync.status === 'synced' && typeof e.sessionId === 'string'; }).map(function (e) { return e.sessionId; }).sort(); }
  w.__fingerprintOf = fingerprintOf; w.__canonical = canonical; w.__syncedIdsOf = syncedIdsOf;
  // The record is written at the Import (fingerprint, synced ids, count, digest, time, the committed
  // rev). The check is a cutover-time check: at the record's rev (the Import's reload, and every kill and
  // reopen until he trains) the committed state is compared with the file and the verdict is persisted
  // into the record; once the state has moved on (a higher rev) Settings shows that verdict as history,
  // never a live alarm. Erase and a new Import clear the record on the native side.
  async function recordVerification(bytes, rev) {
    try {
      var imported = safeParse(bytes);
      var record = { fingerprint: await fingerprintOf(imported), syncedIds: syncedIdsOf(imported), sessions: sessionIds(imported).length, digest: await digestOf(imported), at: new Date().toISOString(), rev: rev };
      var vr = await call('TrainStore', 'setVerified', { json: JSON.stringify(record) });
      store.verifiedRecord = record;
      note({ verifiedRecorded: !!(vr && vr.ok), fingerprint: record.fingerprint.slice(0, 8), rev: rev });
    } catch (e) { note({ verifiedRecordFailed: msg(e) }); }
  }
  async function checkVerified() {
    store.verified = null;
    var rec = store.verifiedRecord; if (!rec || !rec.fingerprint) { renderVerified(); return null; }
    var cur = safeParse(localRaw()); if (!cur) { renderVerified(); return null; }
    var curRev = typeof cur._rev === 'number' ? cur._rev : 0;
    var v = { at: rec.at, rev: rec.rev, sessions: rec.sessions, digest: rec.digest, sessionsNow: sessionIds(cur).length, changedSince: false };
    if (curRev === rec.rev) {
      var fp = await fingerprintOf(cur);
      var syncedNow = {}; syncedIdsOf(cur).forEach(function (id) { syncedNow[id] = true; });
      var missing = (rec.syncedIds || []).filter(function (id) { return !syncedNow[id]; });
      v.fingerprintMatch = fp === rec.fingerprint; v.syncedOk = missing.length === 0; v.unsynced = missing.slice(0, 5);
      v.ok = v.fingerprintMatch && v.syncedOk;
      if (rec.ok !== v.ok || !rec.checkedAt) {       // persist the verdict made at the record's rev
        var merged = Object.assign({}, rec, { ok: v.ok, checkedAt: new Date().toISOString(), fingerprintMatch: v.fingerprintMatch, syncedOk: v.syncedOk });
        try { await call('TrainStore', 'setVerified', { json: JSON.stringify(merged) }); store.verifiedRecord = merged; } catch (e) { note({ verifiedPersistFailed: msg(e) }); }
      }
    } else if (curRev > rec.rev) {
      // the state has moved on since the Import: the verdict made then stands as history
      v.changedSince = true; v.ok = rec.ok === true; v.fingerprintMatch = rec.fingerprintMatch !== false; v.syncedOk = rec.syncedOk !== false; v.checked = rec.checkedAt != null;
    } else {
      v.ok = false; v.fingerprintMatch = false; v.syncedOk = true; v.older = true;   // a state behind the Import's rev is not the imported one
    }
    store.verified = v;
    note({ verified: v.ok, changedSince: v.changedSince, fingerprintMatch: v.fingerprintMatch, syncedOk: v.syncedOk });
    testNote({ verified: v });
    renderVerified();
    return v;
  }
  function localWhen(iso) { try { var d = new Date(iso); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return String(iso); } }
  function renderVerified() {
    var el2 = w.document.getElementById('store-verified'); if (!el2) return;
    var v = store.verified;
    if (!v) { el2.textContent = ''; return; }
    var head = 'Import of ' + localWhen(v.at);
    var count = function (n) { return n + ' session' + (n === 1 ? '' : 's'); };
    if (v.changedSince) {
      el2.textContent = v.checked ? (v.ok ? head + ' verified; state has changed since (' + count(v.sessionsNow) + ' now)' : head + ' not verified (' + (!v.fingerprintMatch ? 'state differs' : 'synced flags changed') + '); state has changed since')
        : head + ' unchecked; state has changed since (' + count(v.sessionsNow) + ' now)';
      return;
    }
    el2.textContent = v.ok ? head + ' verified · ' + count(v.sessions) + ' · digest ' + v.digest
      : head + ' not verified (' + (v.older ? 'older state' : !v.fingerprintMatch ? 'state differs' : 'synced flags changed') + ')';
  }
  w.__checkVerified = checkVerified;

  // --- test surfaces (uiTest launches only): the local copy's head, the kept snapshot, the tombstone probe ---
  function noteLocal() {
    if (!(store.launch && store.launch.uiTest)) return;
    var cur = safeParse(localRaw()); var log = (cur && cur.log) || []; var last = log[log.length - 1];
    testNote({ local: { rev: cur && cur._rev, sessions: log.length, lastSessionId: last && last.sessionId, lastSessionType: last && last.sessionType, lastStatus: last && last.sessionStatus, refused: store.refused } });
  }
  function noteSnapshot(snap) {
    if (!(store.launch && store.launch.uiTest) || !snap) return;
    var parsed = safeParse(snap.bytes);
    testNote({ snapshot: { reason: snap.reason, rev: snap.rev, sessionIds: sessionIds(parsed), sessions: sessionIds(parsed).length } });
  }
  // One live call, CI only (-trainProbeTombstone): a delete tombstone for the probe fixture's unused id
  // (it must start with train-probe-), over the original window.fetch (Origin capacitor://localhost, a
  // real preflight). X-Train-Client comes from -trainProbeClient, "pwa" by default: a test-only header
  // value, stated as such, because the live writer flag says pwa until cutover (the workflow flips it to
  // native at cutover). The function answers noop-absent and writes nothing; no key is sent.
  async function runTombstoneProbe() {
    var s = safeParse(localRaw());
    var id = s && Array.isArray(s.pendingDeletes) ? s.pendingDeletes[0] : null;
    var client = (store.launch && typeof store.launch.probeClient === 'string' && store.launch.probeClient) ? store.launch.probeClient : 'pwa';
    var result = { id: id, url: SYNC_URL, at: new Date().toISOString(), client: client };
    if (!id || String(id).length < 8) { result.error = 'the fixture has no pendingDeletes id of 8+ characters'; note({ probe: result }); return testNote({ probe: result }); }
    if (String(id).indexOf('train-probe-') !== 0) { result.error = 'not the probe fixture'; note({ probe: result }); return testNote({ probe: result }); }
    if (!origFetch) { result.error = 'no fetch'; return testNote({ probe: result }); }
    try {
      var res = await origFetch(SYNC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Train-Client': client }, body: JSON.stringify({ op: 'delete', sessionId: id }) });
      result.status = res.status;
      result.body = String(await res.text()).slice(0, 300);
      try { var parsedBody = JSON.parse(result.body); result.action = parsedBody.action; result.ok = parsedBody.ok; } catch (e) { /* not JSON */ }
    } catch (e) { result.error = msg(e); }
    note({ probe: result });
    return testNote({ probe: result });
  }
  w.__runTombstoneProbe = runTombstoneProbe;

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
  var wake = w.__wake = { sentinels: [], listener: null, lastToken: 0 };
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
  // Native is released only when no live sentinel remains, with the newest token this page knows (a
  // newer acquire still in flight keeps its lock: its token will not match).
  function releaseSentinel(s) {
    if (s.released) return Promise.resolve();
    s.__dispatch();
    note({ wakeRelease: s.__token, live: wake.sentinels.length });
    if (wake.sentinels.length) return Promise.resolve();
    return call('TrainStore', 'wakeRelease', { token: wake.lastToken }).then(function () {}, function (e) { note({ wakeReleaseFailed: msg(e) }); });
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
      if (r.token > wake.lastToken) wake.lastToken = r.token;
      if (w.document.visibilityState === 'hidden') {
        // the page went to the background while the acquire was in flight: give the lock back
        note({ wakeAcquireWhileHidden: r.token });
        return call('TrainStore', 'wakeRelease', { token: r.token }).catch(function () {}).then(function () { throw new Error('NotAllowedError: the document is hidden'); });
      }
      var s = makeSentinel(r.token);
      wake.sentinels.push(s);
      note({ wakeAcquire: r.token });
      return s;
    });
  }
  // the app's own condition for holding the screen (ptWakeOn's callers): a running, unpaused PT item
  function ptRunning() {
    try { return !!(typeof PTS !== 'undefined' && PTS && PTS.run && PTS.run.plan && !PTS.run.paused); } catch (e) { return false; }
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
    // only the sentinels that release covered: native's token is past every lock it released
    var token = ev && typeof ev.token === 'number' ? ev.token : Infinity;
    var covered = wake.sentinels.filter(function (s) { return s.__token < token; });
    covered.forEach(function (s) { s.__dispatch(); });
    note({ nativeWakeReleased: ev && ev.token, reason: ev && ev.reason, released: covered.length, live: wake.sentinels.length });
    // a release this page had not seen (the hidden event did not run before suspension): the app re-acquires
    // under its own condition, as its visibilitychange handler would
    if (covered.length && w.document.visibilityState === 'visible' && ptRunning() && typeof w.ptWakeOn === 'function') { try { w.ptWakeOn(); } catch (e) { logLine('error', ['ptWakeOn', e]); } }
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
    return call('TrainStore', 'cue', { name: name }).then(function (r) { if (r && r.ok) testNote({ cue: { name: name, options: r.options, active: r.active, playing: r.playing } }); else note({ cueRefused: name, error: r && r.lastError }); return r; }, function (e) { note({ cueFailed: name, error: msg(e) }); return { error: msg(e) }; });
  }
  Object.keys(CUES).forEach(function (name) { w[name] = function () { return playCue(name); }; });
  w.unlockAudio = function () {};
  w.toneW = function () {};

  // --- the sound key rides in the store's control sidecar (not state, so not in an export) ---
  function hydrateSoundKey(res) {
    var fileOff = res && (res.soundOff === true || res.soundOff === false) ? res.soundOff : null;
    var local = lsGet(SOUND_KEY);
    if (local === '1' || local === '0') {
      // the page's key is the setting he last tapped (setSoundEnabled writes it first); the store follows it
      var localOff = local === '1';
      if (fileOff !== localOff) call('TrainStore', 'setSoundOff', { off: localOff }).catch(function (e) { note({ soundSaveFailed: msg(e) }); });
      return;
    }
    if (fileOff !== null) lsSet(SOUND_KEY, fileOff ? '1' : '0');                       // an evicted WebView takes the store's copy
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
  var EMBED_ORIGIN = (function () {
    try { return new w.URL(EMBED_BASE).origin; } catch (e) { var m = /^(https?:\/\/[^/]+)/.exec(EMBED_BASE); return m ? m[1] : ''; }
  })();
  if (typeof w.addEventListener === 'function') {
    w.addEventListener('message', function (ev) {
      var d = ev && ev.data;
      if (!d || d.type !== 'train-embed') return;
      if (!ev || ev.origin !== EMBED_ORIGIN) { note({ embedMessageIgnored: ev && ev.origin }); return; }
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
