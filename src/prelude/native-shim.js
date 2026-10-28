// window.betterncm_native: the synchronous V8 bindings of v2 (v8NativeCalls.cpp), rebuilt on a
// sync XHR bridge to the local API server (DESIGN.md 1.4 and 2a).
//
// Wire format: POST <api>/native/<dotted.name>, body = JSON array of arguments,
// reply {"ok":true,"value":...} or {"ok":false,"error":"..."}. Function arguments are sent as
// {"$cb":"<id>"} and invoked later from the SSE stream at <api>/events.

if (!window.betterncm_native) {
  // Captured now, before any page script can patch them.
  const XHR = window.XMLHttpRequest;
  const ES = window.EventSource;
  const fetchFn = window.fetch.bind(window);

  // Argument types as v2 declares them. 'BNString' and 'std::string' are both strings (the names
  // only show up in the error message, as in v2); 'value' is an unchecked cef_v8value_t*.
  const S = 'BNString', STR = 'std::string', INT = 'int', DBL = 'double', V = 'value';

  // name -> [argument types, local implementation or null for the bridge]. Order and arities
  // follow v8NativeCalls.cpp. Its second fs.rename (the 1-argument mkdir variant) can never be
  // reached because the 2-argument one matches first, so 1 argument throws "Too few arguments".
  const APIS = [
    ['test.m.i.c.r.o.b.l.o.c.k', [INT, DBL], (a, b) => '\u{1F34A}\u{1F34A}\u{1F34A}' + (a + b).toFixed(6)],
    ['test.add', [INT, DBL], (a, b) => a + b],
    ['fs.readDir', [S], null],
    ['fs.readDirWithDetails', [S], null],
    ['fs.getDisks', [], null],
    ['fs.getLibraries', [], null],
    ['fs.readFileText', [S], null],
    ['fs.readFileTextAsync', [S, V], readFileTextAsync],
    ['fs.watchDirectory', [S, V], null],
    ['fs.unzip', [S, S], null],
    ['fs.rename', [S, S], null],
    ['fs.exists', [S], null],
    ['fs.getProperties', [S], null],
    ['fs.writeFileText', [STR, STR], null],
    ['fs.remove', [S], null],
    ['app.auto_update', [STR], null],
    // The API server answers with Cache-Control: no-store, so a plain reload is enough.
    ['app.reloadIgnoreCache', [], () => { setTimeout(() => location.reload()); return true; }],
    ['app.datapath', [], null],
    ['app.ncmpath', [], null],
    // Called during render; hard-coded so it costs no round trip. Keep in sync with config.BNCM_VERSION.
    ['app.version', [], () => '1.3.4'],
    ['app.restart', [], null],
    ['app.crash', [], () => { throw new Error('not supported'); }],
    ['native_plugin.getRegisteredAPIs', [], () => []],
    ['native_plugin.call', [STR, V], () => { throw new Error('Invalid api id'); }],
  ];

  // Callback registry. Ids carry a per-frame prefix: every frame of a page target shares one
  // SSE target, so a frame must ignore ids that belong to another frame. The prefix is new on
  // every page load, so it doubles as the document's context id for the server.
  const framePrefix = Math.random().toString(36).slice(2, 10);
  let cbSeq = 0;
  const callbacks = Object.create(null);
  let events = null;

  function ensureEvents() {
    if (events || !ES) return;
    const url = BETTERNCM_API_PATH + '/events?key=' + encodeURIComponent(BETTERNCM_API_KEY)
      + '&target=' + encodeURIComponent(__BNCM_TARGET__) + '&ctx=' + framePrefix;
    events = new ES(url);
    events.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const fn = msg && callbacks[msg.cb];
      if (!fn) return;
      try {
        fn.apply(window, Array.isArray(msg.args) ? msg.args : []);
      } catch (e) {
        console.error('[BetterNCM] native callback failed', e);
      }
    };
  }

  function enc(arg) {
    if (typeof arg !== 'function') return arg;
    const id = framePrefix + '-' + (++cbSeq);
    callbacks[id] = arg;
    ensureEvents();
    return { $cb: id };
  }

  function checkArgs(types, args) {
    if (args.length < types.length || args.length > types.length) {
      throw new Error((args.length < types.length ? 'Too few' : 'Too many') + ' arguments. Expected '
        + types.length + ' arguments, received ' + args.length + ' arguments.');
    }
    types.forEach((t, i) => {
      const a = args[i];
      const ok = t === V
        || ((t === S || t === STR) && typeof a === 'string')
        || (t === INT && Number.isInteger(a) && a >= -0x80000000 && a <= 0x7fffffff)
        || (t === DBL && typeof a === 'number');
      if (!ok) throw new Error('Invalid argument ' + i + '. Expected an ' + t + ' but received a different type.');
    });
  }

  function bridge(name, args) {
    const x = new XHR();
    x.open('POST', BETTERNCM_API_PATH + '/native/' + name, false);
    x.setRequestHeader('BETTERNCM_API_KEY', BETTERNCM_API_KEY);
    x.setRequestHeader('X-BNCM-Target', __BNCM_TARGET__);
    // per-document id: the server ties watchDirectory watchers to this document's EventSource
    x.setRequestHeader('X-BNCM-Context', framePrefix);
    x.setRequestHeader('Content-Type', 'application/json');
    x.send(JSON.stringify(args.map(enc)));
    let r;
    try {
      r = JSON.parse(x.responseText);
    } catch {
      throw new Error('betterncm_native.' + name + ': bad response (HTTP ' + x.status + ')');
    }
    if (!r || !r.ok) throw new Error((r && r.error) || 'betterncm_native.' + name + ' failed');
    return r.value;
  }

  // v2 reads the file on a worker thread and calls back with the text (empty if unreadable).
  function readFileTextAsync(path, cb) {
    fetchFn(BETTERNCM_API_PATH + '/fs/read_file_text?path=' + encodeURIComponent(path), {
      headers: { BETTERNCM_API_KEY },
    })
      .then((r) => (r.ok ? r.text() : ''))
      .catch(() => '')
      .then((text) => { if (typeof cb === 'function') cb(text); });
    return undefined;
  }

  const root = {};
  for (const [name, types, local] of APIS) {
    const steps = name.split('.');
    let obj = root;
    for (const step of steps.slice(0, -1)) obj = obj[step] || (obj[step] = {});
    const fn = function () {
      const args = Array.prototype.slice.call(arguments);
      checkArgs(types, args);
      return local ? local.apply(null, args) : bridge(name, args);
    };
    Object.defineProperty(fn, 'name', { value: name });
    obj[steps[steps.length - 1]] = fn;
  }

  // A window property is enough for the framework's bare `betterncm_native` references.
  window.betterncm_native = root;
}
