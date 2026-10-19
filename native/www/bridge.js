// bridge.js: the native shell's side of the web app. Loaded by the shell's patched copy of
// index.html, after the inline script and before DOMContentLoaded fires. Gate 0 scope only.
//
// Rules this file keeps (plan v4):
//   - the live index.html, data.js and style.css are never edited; the shell patches its own copy;
//   - one writer: the shell never posts to the sync function before cutover, so the three sync
//     functions are no-ops at parse time (the real serialized wrappers come with the sync work);
//   - the shell is never handed off: handoffSupported() is false here, so the hand-off release's
//     switch, backstop fetch, hold and banner never run in the app.
(function (w) {
  'use strict';

  // --- hand-off: never in the shell ---
  w.handoffSupported = function () { return false; };

  // --- sync off (gate 0 and every pre-cutover build): no network from the shell ---
  w.pushUnsynced = async function () { return; };
  w.syncEntry = async function () { return; };
  w.postSync = async function () { throw new Error('sync is off in the shell before cutover'); };

  // --- ready-hook: the durable store hydrates here later; gate 0 resolves at once ---
  w.__trainReady = function () { return Promise.resolve(); };

  // --- gate 0: prove the bridge, one in-app plugin and one Capacitor plugin ---
  var result = { bridge: null, trainStore: null, capPlugin: null, isSecureContext: w.isSecureContext === true, origin: w.location.origin, errors: [] };
  w.__gate0 = result;

  function plugins() { return (w.Capacitor && w.Capacitor.Plugins) || null; }
  function callViaProxy(name, method, options) {
    var p = plugins();
    if (!p || !p[name] || typeof p[name][method] !== 'function') return Promise.reject(new Error('no proxy for ' + name + '.' + method));
    return p[name][method](options);
  }
  function callViaTransport(name, method, options) {
    if (!w.Capacitor || typeof w.Capacitor.nativePromise !== 'function') return Promise.reject(new Error('no nativePromise transport'));
    return w.Capacitor.nativePromise(name, method, options);
  }
  // The JSExport-injected proxies are the first choice; Capacitor.nativePromise is the documented
  // alternative. Both are recorded so the report says which one answered.
  function call(name, method, options) {
    return callViaProxy(name, method, options).then(function (r) { return { via: 'proxy', value: r }; }, function (e1) {
      return callViaTransport(name, method, options).then(function (r) { return { via: 'nativePromise', value: r, proxyError: String(e1 && e1.message || e1) }; });
    });
  }

  function run() {
    var p = plugins();
    result.bridge = { hasCapacitor: !!w.Capacitor, hasPlugins: !!p, pluginNames: p ? Object.keys(p).sort() : [], headers: (w.Capacitor && w.Capacitor.PluginHeaders) ? w.Capacitor.PluginHeaders.map(function (h) { return h.name; }).sort() : [] };
    return call('TrainStore', 'ping', { echo: 'gate0' })
      .then(function (r) { result.trainStore = r; }, function (e) { result.errors.push('TrainStore.ping: ' + String(e && e.message || e)); })
      .then(function () { return call('Filesystem', 'getUri', { path: 'gate0.txt', directory: 'LIBRARY' }); })
      .then(function (r) { result.capPlugin = r; }, function (e) { result.errors.push('Filesystem.getUri: ' + String(e && e.message || e)); })
      .then(function () {
        result.ok = !!(result.trainStore && result.trainStore.value && result.trainStore.value.pong === 'gate0' && result.capPlugin && result.capPlugin.value && typeof result.capPlugin.value.uri === 'string' && result.isSecureContext && result.origin === 'capacitor://localhost' && result.errors.length === 0);
        var json = JSON.stringify(result);
        // Hand the report to native so an XCUITest can read it without DOM access.
        return call('TrainStore', 'report', { json: json }).catch(function (e) { result.errors.push('TrainStore.report: ' + String(e && e.message || e)); });
      });
  }

  if (w.document.readyState === 'loading') w.document.addEventListener('DOMContentLoaded', function () { run(); });
  else run();
})(window);
