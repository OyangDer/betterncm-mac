// window.channel for plugins written against Windows NCM (DESIGN.md 2c). On macOS the native
// bridge is window.ncmChannelOSX.postMessage plus the MNBCallback seq map that NCM's own SDK
// keeps (app.chunk: Et.callNative / Et.registerCallForMNBChannel). Gated by mac.channelShim
// because once window.channel exists, NCM's legacyNativeCmder routes through it too.
//
// Native appears to keep one registration per command: when NCM registers a command again it
// drops the old seq from the map. So registerCall never re-registers a command NCM already
// listens to; it records the seq of every registerCall that goes through postMessage and
// listens on MNBCallback for the newest seq of each command instead.

function __bncmInstallChannelShim() {
  if (typeof __BNCM_CFG__ === 'undefined' || __BNCM_CFG__['mac.channelShim'] !== 'true') return;
  if (window.channel) return;

  const SEQ_PREFIX = '::[[bncm]]::';
  let seq = 0;
  const nextSeq = () => SEQ_PREFIX + (++seq);

  const listeners = Object.create(null); // command -> [callback]
  const latestSeq = Object.create(null); // command -> newest registerCall seq (NCM's or ours)
  const commandOf = Object.create(null); // registerCall seq -> command

  function noteRegister(msg) {
    if (msg && msg.method === 'registerCall' && typeof msg.command === 'string') {
      latestSeq[msg.command] = msg.seq;
      commandOf[msg.seq] = msg.command;
    }
  }

  let wrapped = false;
  function wrapPostMessage() {
    const ch = window.ncmChannelOSX;
    if (wrapped || !ch || typeof ch.postMessage !== 'function') return;
    const orig = ch.postMessage;
    try {
      ch.postMessage = function (msg) {
        try { noteRegister(msg); } catch { /* never break the native call */ }
        return orig.apply(this, arguments);
      };
      wrapped = ch.postMessage !== orig;
    } catch (e) {
      console.warn('[BetterNCM] channel shim: cannot wrap ncmChannelOSX.postMessage', e);
    }
  }

  function post(msg) {
    if (!wrapped) noteRegister(msg);
    window.ncmChannelOSX.postMessage(msg);
  }

  const lastArgs = Object.create(null); // command -> args of the newest event seen

  function dispatch(command, args) {
    lastArgs[command] = args;
    for (const cb of (listeners[command] || []).slice()) {
      try {
        cb.apply(window, args);
      } catch (e) {
        console.error('[BetterNCM] channel callback for ' + command + ' failed', e);
      }
    }
  }

  // Seq map entries are read by NCM's MNBCallback dispatcher; it is looked up on each use
  // because a later Et.setup() may replace the getter.
  function callbackMap() {
    return window.$$MNBCallbackMap;
  }

  // Events for commands that NCM registered itself arrive with NCM's seq, which is not in our
  // part of the map: a "post" hook (assigning window.MNBCallback adds one) picks those up.
  function hookMNBCallback() {
    const d = Object.getOwnPropertyDescriptor(window, 'MNBCallback');
    if (!d || !d.set) return false;
    window.MNBCallback = (s, args) => {
      const command = commandOf[s];
      if (!command || String(s).startsWith(SEQ_PREFIX) || latestSeq[command] !== s) return;
      dispatch(command, Array.isArray(args) ? args : []);
    };
    return true;
  }

  // On Windows, native fires audioplayer.onLoad for the restored track after plugins have
  // registered; on macOS it fires before plugins load, so a plugin that fetches per-track data
  // on onLoad (RefinedNowPlaying's lyrics) never sees the track that is already loaded. Replay
  // one onLoad to such late listeners once the player store knows the current track.
  function currentTrackId() {
    try {
      let f = document.getElementById('root')._reactRootContainer._internalRoot.current;
      for (let i = 0; f && i < 50; i++, f = f.child) {
        const store = f.memoizedProps && f.memoizedProps.store;
        if (store) {
          const p = store.getState().playing;
          return p && p.resourceTrackId ? String(p.resourceTrackId) : '';
        }
      }
    } catch { /* store not mounted yet */ }
    return '';
  }

  function replayLoadTo(cb) {
    let tries = 0;
    const timer = setInterval(() => {
      if (lastArgs['audioplayer.onLoad']) { clearInterval(timer); return; } // a real event came
      const id = currentTrackId();
      if (!id && ++tries < 60) return;
      clearInterval(timer);
      if (!id) return;
      console.debug('[BetterNCM] channel shim: replaying audioplayer.onLoad for', id);
      try {
        cb.call(window, id, {});
      } catch (e) {
        console.error('[BetterNCM] replayed audioplayer.onLoad failed', e);
      }
    }, 500);
  }

  const channel = {
    call(cmd, cb, params) {
      const s = nextSeq();
      const map = callbackMap();
      if (map) map[s] = { type: 'call', source: 'bncm', callback: typeof cb === 'function' ? cb : () => {} };
      post({ method: 'call', command: cmd, params: params || [], seq: s });
    },
    registerCall(evt, cb) {
      if (typeof cb !== 'function') return;
      const list = listeners[evt] || (listeners[evt] = []);
      if (!list.includes(cb)) list.push(cb);
      if (evt === 'audioplayer.onLoad' && !lastArgs[evt]) replayLoadTo(cb);
      if (latestSeq[evt]) return; // already registered natively (by NCM or by us)
      const s = nextSeq();
      const map = callbackMap();
      if (map) {
        map[s] = {
          type: 'registerCall',
          source: 'bncm',
          callback: (...args) => { if (latestSeq[evt] === s) dispatch(evt, args); },
        };
      }
      post({ method: 'registerCall', command: evt, seq: s });
    },
    removeRegisterCall(evt, cb) {
      const list = listeners[evt];
      if (!list) return;
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    },
    // Must stay undefined: dbg.Command treats `channel.viewCall` as "running on Windows CEF".
    viewCall: undefined,
  };

  // Wrap as early as possible so NCM's own boot-time registrations are recorded.
  wrapPostMessage();

  // NCM's parser-blocking bundles have run by DOMContentLoaded, so their feature detection does
  // not see window.channel; this capture listener still runs before the framework's own.
  window.addEventListener('DOMContentLoaded', () => {
    if (window.channel) return;
    if (!window.ncmChannelOSX) {
      console.warn('[BetterNCM] channel shim: window.ncmChannelOSX is missing');
      return;
    }
    wrapPostMessage();
    if (!hookMNBCallback()) console.warn('[BetterNCM] channel shim: MNBCallback hook unavailable');
    // NCM's own adapter (callAdapter / registerCallAdapter / doAdapter) checks window.channel on
    // every call and would route all of NCM's native traffic through this shim, which breaks
    // calls such as os.getSystemInfo. So code running from NCM's bundles still sees no channel
    // and keeps using its native path; plugin code (eval'd, other script URLs) gets the shim.
    const NCM_SCRIPT = /\(?orpheus:\/\/orpheus\/pub\//;
    const calledFromNcm = () => {
      const frames = new Error().stack.split('\n'); // [0] "Error", [1] this getter's frame chain
      for (let i = 1; i < frames.length; i++) {
        if (frames[i].includes('calledFromNcm') || frames[i].includes('channelGetter')) continue;
        return NCM_SCRIPT.test(frames[i]) && !frames[i].includes('eval at');
      }
      return false;
    };
    Object.defineProperty(window, 'channel', {
      configurable: true,
      enumerable: true,
      get: function channelGetter() { return calledFromNcm() ? undefined : channel; },
      // A plugin that replaces window.channel wholesale gets a plain property again.
      set(v) { Object.defineProperty(window, 'channel', { value: v, writable: true, configurable: true, enumerable: true }); },
    });
  }, true);
}

__bncmInstallChannelShim();
