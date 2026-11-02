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
        try { if (holdWindowSetup(this, orig, msg, arguments)) return undefined; } catch { /* send it as it is */ }
        return orig.apply(this, arguments);
      };
      wrapped = ch.postMessage !== orig;
    } catch (e) {
      console.warn('[BetterNCM] channel shim: cannot wrap ncmChannelOSX.postMessage', e);
    }
  }

  // Native injects ncmChannelOSX after this script runs but before NCM's earliest registerCall
  // (audioplayer.onPlayState among them), so wrapping it at DOMContentLoaded misses those. Trap
  // the assignment to wrap it at once; if native defines the property some other way the trap is
  // simply replaced and the DOMContentLoaded wrap below still runs.
  function trapChannelObject() {
    if (window.ncmChannelOSX || Object.getOwnPropertyDescriptor(window, 'ncmChannelOSX')) return;
    try {
      Object.defineProperty(window, 'ncmChannelOSX', {
        configurable: true,
        enumerable: true,
        get() { return undefined; },
        set(v) {
          Object.defineProperty(window, 'ncmChannelOSX', { value: v, writable: true, configurable: true, enumerable: true });
          wrapPostMessage();
        },
      });
    } catch { /* leave it to the DOMContentLoaded wrap */ }
  }

  // At every load NCM's page sets its window up: winhelper.setWindowPosition with the saved
  // windowed frame, showWindow("maximize"), initMainWindow. Done to a window in full screen (a
  // reload: a plugin switched, BetterNCM restarted) it drops out of full screen half way, left
  // without its close / minimize / zoom buttons. Its app.setCefNativeTransparentUIEnabled, sent a
  // little later, hides the title bar a full-screen window shows at the top edge: the buttons are
  // gone until full screen is left and entered again. So on a reload (this window already loaded once:
  // a flag in sessionStorage) native is asked first whether the window is in full screen; until it
  // answers these calls wait, and in full screen they are answered here and not sent.
  const WINDOW_SETUP = new Set([
    'winhelper.setWindowPosition', 'winhelper.setNativeWindowRect', 'winhelper.initMainWindow', 'app.setCefNativeTransparentUIEnabled',
  ]);
  const LOADED_BEFORE = 'bncm-main-window-loaded';
  let setupHeld = 'unchecked'; // then [] while native is asked, and 'fullscreen' or null (send them)
  function isWindowSetup(msg) {
    // NCM's own calls only (ours, the lyrics window's moves among them, always go)
    return !!msg && msg.method === 'call' && !String(msg.seq).startsWith(SEQ_PREFIX) && (WINDOW_SETUP.has(msg.command)
      || (msg.command === 'winhelper.showWindow' && Array.isArray(msg.params) && msg.params[0] === 'maximize'));
  }
  // At the first setup call (NCM's callback map exists by then): a reload asks native.
  function startSetupGuard(ch, orig) {
    setupHeld = null;
    let reload = false;
    try {
      reload = sessionStorage.getItem(LOADED_BEFORE) === '1';
      sessionStorage.setItem(LOADED_BEFORE, '1');
    } catch { /* no sessionStorage: nothing is held */ }
    const map = callbackMap();
    if (!reload || !map) return;
    setupHeld = [];
    const settle = (fullscreen) => {
      if (!Array.isArray(setupHeld)) return;
      const queue = setupHeld;
      setupHeld = fullscreen ? 'fullscreen' : null;
      if (fullscreen) {
        console.debug('[BetterNCM] channel shim: reloaded in full screen; the window is left as it is');
        setTimeout(() => { setupHeld = null; }, 3000); // the page's start-up only
      }
      for (const [msg, args] of queue) {
        if (fullscreen) answer(msg);
        else orig.apply(ch, args);
      }
    };
    const s = nextSeq();
    map[s] = { type: 'call', source: 'bncm', callback: (fullscreen) => settle(!!fullscreen) };
    orig.call(ch, { method: 'call', command: 'winhelper.isWindowFullScreen', params: [], seq: s });
    setTimeout(() => settle(false), 1500); // no answer: as if there were no guard
  }
  function answer(msg) {
    try { window.MNBCallback(msg.seq, []); } catch (e) { console.error('[BetterNCM] could not answer ' + msg.command, e); }
  }
  // -> true when the call is held or answered here instead of being sent
  function holdWindowSetup(ch, orig, msg, args) {
    if (!isWindowSetup(msg)) return false;
    if (setupHeld === 'unchecked') startSetupGuard(ch, orig);
    if (setupHeld === null) return false;
    if (setupHeld === 'fullscreen') answer(msg);
    else setupHeld.push([msg, args]);
    return true;
  }

  function post(msg) {
    if (!wrapped) noteRegister(msg);
    window.ncmChannelOSX.postMessage(msg);
  }

  const lastArgs = Object.create(null); // command -> args of the newest event seen

  // macOS native fires audioplayer.onPlayProgress ~50 times a second, far more often than the
  // Windows client the plugins were written for, and RefinedNowPlaying rescans the page on each
  // one. Plugins get at most one event per PROGRESS_INTERVAL_MS (the newest, delivered on a
  // trailing timer); a track change or a seek-like jump goes through at once. NCM's own
  // listeners are not affected.
  //
  // While the page is not drawn (window covered, on another Space, minimized) nothing the
  // plugins compute per event can be seen, so they get one per HIDDEN_INTERVAL_MS (RNPN's lyric
  // page kept NCM at ~18% CPU there). CEF on macOS reports a covered window as 'visible' but
  // stops producing frames, so "drawn" means an animation frame requested at most every
  // FRAME_PROBE_MS arrived within that time. The frame that comes when the window shows again
  // delivers the newest event at once.
  const PROGRESS = 'audioplayer.onPlayProgress';
  const PROGRESS_INTERVAL_MS = 100;
  const HIDDEN_INTERVAL_MS = 1000;
  const FRAME_PROBE_MS = 500;
  let progressSentAt = -Infinity;
  let progressPending = null;
  let progressTimer = 0;
  let progressSeen = null; // { id, pos, at } of the newest event received
  let probeAt = -Infinity;
  let probePending = false;

  function isDrawn(now) {
    if (document.hidden) return false;
    if (probePending) return now - probeAt < FRAME_PROBE_MS;
    if (now - probeAt >= FRAME_PROBE_MS && typeof requestAnimationFrame === 'function') {
      probePending = true;
      probeAt = now;
      requestAnimationFrame(() => {
        probePending = false;
        flushProgress();
      });
    }
    return true;
  }

  function flushProgress() {
    clearTimeout(progressTimer);
    progressTimer = 0;
    const pending = progressPending;
    progressPending = null;
    if (!pending) return;
    progressSentAt = performance.now();
    deliver(PROGRESS, pending);
  }

  function isProgressJump(args, now) {
    const id = String(args[0]);
    const pos = parseFloat(args[1]);
    const prev = progressSeen;
    progressSeen = { id, pos, at: now };
    if (!prev || prev.id !== id || !Number.isFinite(pos) || !Number.isFinite(prev.pos)) return true;
    // Paused playback repeats the same position; playing advances by about the elapsed time.
    return pos < prev.pos - 0.25 || pos > prev.pos + (now - prev.at) / 1000 + 0.75;
  }

  function dispatchProgress(args) {
    const now = performance.now();
    const interval = isDrawn(now) ? PROGRESS_INTERVAL_MS : HIDDEN_INTERVAL_MS;
    progressPending = args;
    if (isProgressJump(args, now) || now - progressSentAt >= interval) {
      flushProgress();
      return;
    }
    if (!progressTimer) progressTimer = setTimeout(flushProgress, Math.max(0, interval - (now - progressSentAt)));
  }

  // NCM's own progress listener (its play bar's slider and times) gets the same ~50 events a
  // second, each re-rendering the play bar, which kept NCM's page producing a frame for nearly
  // every one: ~27 points of one core while playing, measured on an M5. Its callback in NCM's
  // seq map is wrapped (on its first event, below) to pass the newest event at most every
  // NCM_PROGRESS_MS, and every NCM_COVERED_MS while the bar cannot be seen: RefinedNowPlaying's
  // page covers it, or the window is not drawn. Track changes and seeks pass at once, as for
  // plugins, so nothing that keys on them waits.
  const NCM_PROGRESS_MS = 250;
  const NCM_COVERED_MS = 1000;
  const RNP_PAGE_OPEN = 'rnp-lyric-page-open';
  const LYRICS_WINDOW_OPEN = 'bncm-lyrics-open'; // the lyrics window covers NCM's (lyrics-bridge.js)
  const throttledNcm = new WeakSet();

  function throttleNcmProgress(s) {
    const entry = callbackMap()?.[s];
    const orig = entry && entry.callback;
    if (typeof orig !== 'function' || throttledNcm.has(orig)) return;
    let sentAt = -Infinity;
    let pending = null;
    let timer = 0;
    let seen = null;
    const flush = () => {
      clearTimeout(timer);
      timer = 0;
      const args = pending;
      pending = null;
      if (!args) return;
      sentAt = performance.now();
      orig.apply(window, args);
    };
    const wrappedCb = function (...args) {
      const now = performance.now();
      const id = String(args[0]);
      const pos = parseFloat(args[1]);
      const jump = !seen || seen.id !== id || !Number.isFinite(pos) || !Number.isFinite(seen.pos)
        || pos < seen.pos - 0.25 || pos > seen.pos + (now - seen.at) / 1000 + 0.75;
      seen = { id, pos, at: now };
      const cl = document.body?.classList;
      const covered = cl?.contains(RNP_PAGE_OPEN) || cl?.contains(LYRICS_WINDOW_OPEN) || !isDrawn(now);
      const interval = covered ? NCM_COVERED_MS : NCM_PROGRESS_MS;
      pending = args;
      if (jump || now - sentAt >= interval) {
        flush();
        return;
      }
      if (!timer) timer = setTimeout(flush, Math.max(0, interval - (now - sentAt)));
    };
    throttledNcm.add(wrappedCb);
    entry.callback = wrappedCb;
  }

  // macOS sends onPlayState as [id, "id|pause|RANDOM", 2]; plugins written for Windows take the
  // last "|" segment as the state (RefinedNowPlaying: .split("|").pop()), so drop the suffix.
  const PLAY_STATE = 'audioplayer.onPlayState';
  const PLAY_STATE_ARG = /^([^|]*\|(?:pause|resume|play|stop))\|[^|]*$/;

  // Raw, unthrottled events for BetterNCM's own preludes (the lyrics window's bridge keeps its
  // own pace): window.__bncmChannelTap((command, args) => ...).
  const taps = [];
  window.__bncmChannelTap = (fn) => { if (typeof fn === 'function') taps.push(fn); };

  function dispatch(command, args) {
    for (const t of taps) {
      try { t(command, args); } catch (e) { console.error('[BetterNCM] channel tap failed', e); }
    }
    if (command === PROGRESS) {
      healPlayState(args);
      dispatchProgress(args);
      return;
    }
    if (command === PLAY_STATE && typeof args[1] === 'string') {
      args = args.slice();
      args[1] = args[1].replace(PLAY_STATE_ARG, '$1');
    }
    deliver(command, args);
  }

  function deliver(command, args) {
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
      if (!commandOf[s] && !latestSeq[PLAY_STATE] && looksLikePlayState(s, args)) {
        // Registered before the wrap could see it (see trapChannelObject); its events are unique.
        commandOf[s] = PLAY_STATE;
        latestSeq[PLAY_STATE] = s;
      }
      const command = commandOf[s];
      if (!command || String(s).startsWith(SEQ_PREFIX) || latestSeq[command] !== s) return;
      if (command === PROGRESS) {
        try { throttleNcmProgress(s); } catch { /* NCM keeps its unthrottled events */ }
      }
      dispatch(command, Array.isArray(args) ? args : []);
    };
    return true;
  }

  function looksLikePlayState(s, args) {
    const entry = callbackMap()?.[s];
    return !!entry && entry.type === 'registerCall' && Array.isArray(args) && args.length === 3
      && typeof args[1] === 'string' && PLAY_STATE_ARG.test(args[1]) && args[1].startsWith(String(args[0]) + '|');
  }

  // No onPlayState fires after a page load until playback is toggled, and RefinedNowPlaying's
  // fallback (class names on NCM's play button) does not match the macOS client, so a plugin that
  // registers late shows "paused" while music plays. Give such a listener one state event, read
  // from whether the progress position advances (NCM's store is stale right after a reload).
  function replayPlayStateTo(cb) {
    const before = progressSeen;
    setTimeout(() => {
      if (lastArgs[PLAY_STATE]) return; // a real event came
      const now = progressSeen;
      const id = (now && now.id) || currentTrackId();
      if (!id) return;
      const playing = !!now && performance.now() - now.at < 1000 && (!before || now.pos > before.pos);
      console.debug('[BetterNCM] channel shim: replaying audioplayer.onPlayState', playing ? 'resume' : 'pause');
      try {
        cb.call(window, id, id + '|' + (playing ? 'resume' : 'pause'), playing ? 1 : 2);
      } catch (e) {
        console.error('[BetterNCM] replayed audioplayer.onPlayState failed', e);
      }
    }, 1500);
  }

  // NCM's play button follows its store, which can say paused while native plays (seen after
  // reloads of the page and resumes NCM's page did not ask for: the store keeps what it had). When the position keeps advancing for a second and more while the store says paused,
  // tell the store it is playing, with the action NCM's own audio listener uses (playing/onUpdate;
  // 2 is its Playing). A real pause stops the position at once, so it is never undone.
  const PLAYING = 2;
  const HEAL_AFTER_MS = 1200;
  let healFrom = null; // { id, pos, at } of the last check, when the store said paused
  let healNext = 0; // the store is read at most once per HEAL_AFTER_MS
  function healPlayState(args) {
    const now = performance.now();
    if (now < healNext) return;
    healNext = now + HEAL_AFTER_MS;
    const id = String(args[0]);
    const pos = parseFloat(args[1]);
    const store = playingStore();
    if (!Number.isFinite(pos) || !store || store.getState().playing?.playingState === PLAYING) { healFrom = null; return; }
    const prev = healFrom;
    healFrom = { id, pos, at: now };
    // paused at both checks, and played on in between (at least 80% of the time that passed)
    if (!prev || prev.id !== id || pos - prev.pos < ((now - prev.at) / 1000) * 0.8) return;
    healFrom = null;
    try {
      console.debug('[BetterNCM] channel shim: NCM\'s store said paused while playing; set it to playing');
      store.dispatch({ type: 'playing/onUpdate', payload: { playingState: PLAYING } });
    } catch (e) {
      console.error('[BetterNCM] could not set the play state', e);
    }
  }

  // On Windows, native fires audioplayer.onLoad for the restored track after plugins have
  // registered; on macOS it fires before plugins load, so a plugin that fetches per-track data
  // on onLoad (RefinedNowPlaying's lyrics) never sees the track that is already loaded. Replay
  // one onLoad to such late listeners once the player store knows the current track.
  function playingStore() {
    try {
      let f = document.getElementById('root')._reactRootContainer._internalRoot.current;
      for (let i = 0; f && i < 50; i++, f = f.child) {
        const store = f.memoizedProps && f.memoizedProps.store;
        if (store) return store;
      }
    } catch { /* store not mounted yet */ }
    return null;
  }

  function currentTrackId() {
    const p = playingStore()?.getState().playing;
    return p && p.resourceTrackId ? String(p.resourceTrackId) : '';
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
      if (evt === PLAY_STATE && !lastArgs[evt]) replayPlayStateTo(cb);
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
  trapChannelObject();

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
