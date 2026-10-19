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
//     copies labelled when it cannot.
// localStorage stays the synchronous working copy; the file is the durability backstop.
(function (w) {
  'use strict';

  var STATE_KEY = 'train_state';
  var SEED_KEY = 'train_seed_rev';
  var GEN_KEY = 'train_store_gen';
  var SNAP_KEY = 'train_state_snapshot';
  var cfg = w.__storeConfig || {};               // tests shorten the waits; the app uses the defaults
  var READ_RETRY_MS = cfg.readRetryMs || 5000;
  var QUIESCE_MS = cfg.quiesceMs || 10000;
  var EXPORT_WAIT_MS = cfg.exportWaitMs || 3000;

  // --- hand-off: never in the shell ---
  w.handoffSupported = function () { return false; };

  // --- sync off before cutover; the guard the real wrappers will honour ---
  var sync = w.__sync = { inflight: 0, quiescing: false };
  w.pushUnsynced = async function () { return; };
  w.syncEntry = async function () { return; };
  w.postSync = async function () { throw new Error('sync is off in the shell before cutover'); };

  var store = w.__store = {
    seeded: false, base: 0, rev: 0, seedRev: 0, generation: null,
    refused: false, pendingSaves: 0, inflightSaves: 0, lastSaveFailed: false, lastCommitted: null,
    chain: Promise.resolve(), txHold: null, snapshot: null, banner: null, hydrated: false, readyPromise: null, events: [],
    config: { readRetryMs: READ_RETRY_MS, quiesceMs: QUIESCE_MS, exportWaitMs: EXPORT_WAIT_MS }
  };
  function note(ev) { store.events.push(ev); if (store.events.length > 200) store.events.shift(); }
  function msg(e) { return String(e && e.message || e); }

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
  function hideLoading() { var v = w.document.getElementById('store-loading'); if (v) { v.hidden = true; v.innerHTML = ''; } store.loading = null; }
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
  }
  function hideBanner() { var b = w.document.getElementById('store-banner'); if (b) { b.hidden = true; b.innerHTML = ''; } store.banner = null; }

  // --- seeding: rev, seedRev and generation move together, persisted before any save is sent ---
  function seed(rev, seedRev, generation) {
    store.base = rev; store.rev = rev; store.seedRev = seedRev; store.generation = generation; store.seeded = true;
    lsSet(SEED_KEY, String(seedRev)); lsSet(GEN_KEY, String(generation));
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
    var localGen = Number(lsGet(GEN_KEY));
    var localSeed = Number(lsGet(SEED_KEY));
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
    // 4. this page is ahead within its own acknowledged lineage: write through the raw string
    if (localRev > file.rev) {
      if (Number.isFinite(localSeed) && localSeed <= file.rev) {
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
    if (!o || !o.fixture) return;
    if (localRaw() !== null) return;
    var st = await call('TrainStore', 'status');
    if (!st || st.hasFile || (st.rev || 0) !== 0) return;
    var resp = await w.fetch('fixtures/' + o.fixture + '.json', { cache: 'no-store' });
    var data = await resp.json();
    var bytes = prepareImportBytes(data, 0);
    var r = await call('TrainStore', 'importState', { bytes: bytes, base: 0 });
    note({ fixture: o.fixture, imported: !!(r && r.accepted), rev: r && r.rev });
  }

  w.__trainReady = function () {
    if (!store.readyPromise) {
      store.readyPromise = (async function () {
        try { await maybeImportFixture(); } catch (e) { note({ fixtureFailed: msg(e) }); }
        await hydrate();
        store.hydrated = true;
        hideLoading();
      })();
    }
    return store.readyPromise;
  };

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
        if (r && r.reason === 'generation') return { superseded: true };
        store.refused = true; store.lastSaveFailed = true;
        note({ refused: r && r.reason, base: base, fileRev: r && r.rev });
        showBanner('This copy fell behind the app’s saved data (' + ((r && r.reason) || 'refused') + ') and stops saving until the app relaunches. Export this screen’s copy from Settings if you need it.');
        return { refused: true, reason: r && r.reason };
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
    text += ' The current data is kept as a snapshot in the app.';
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
      if (!(r && r.accepted)) { abortTx(); note({ importRefused: r && r.reason }); refusedModal('Import did not happen', 'The app refused it (' + ((r && r.reason) || 'unknown') + '). Nothing changed; try again.'); return; }
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
      if (!(r && r.accepted)) { abortTx(); refusedModal('Erase did not happen', 'The app refused it (' + ((r && r.reason) || 'unknown') + '). Nothing changed.'); return; }
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
      + (store.snapshot ? '<div class="setting-row" style="margin-top:8px;"><div><div style="font-weight:600;">Saved snapshot</div><div id="store-snapshot-line" style="font-size:12px;color:var(--text2);">…</div></div><button id="store-snapshot-export" class="btn btn-small btn-secondary">Export the saved snapshot</button></div>' : '');
    c.appendChild(card);
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

  // restore a kept snapshot's record across reloads (the bytes stay in localStorage)
  store.snapshot = safeParse(lsGet(SNAP_KEY));
})(window);
