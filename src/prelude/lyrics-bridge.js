// The lyrics window's bridge in NCM's page (LYRICS-WINDOW.md; config mac.lyricsWindow).
//
// It has no UI. While the window is closed it only watches for the lyric page being asked for:
// every way NCM opens its own now-playing (vinyl) page ends in one RxJS BehaviorSubject being set
// to 'opening', so that subject's next() is wrapped and the window opens instead. When the
// subject cannot be found (another NCM build), a click on the play bar's cover is caught, and NCM's
// page starting to open by any other way is seen in the store and collapsed again. While the
// window shows, it sends the track, the play state and progress at 4 Hz, and runs the window's
// commands in NCM's page, through NCM's own dva effects where NCM has them.
//
// Messages go out through the CDP binding __bncmLyricsPost (src/lyrics-window.mjs); commands come
// in as window.__bncmLyricsBridge.cmd(msg), evaluated by the injector.

const POST = '__bncmLyricsPost';
const OPEN_CLASS = 'bncm-lyrics-open'; // the window covers NCM's; channel-shim.js slows NCM's play bar
const STOCK_CLASS = 'bncm-stock-vinyl'; // NCM's own page may open (shift-click, fallback)
const PANEL_CLASS = 'bncm-rnp-panel'; // compat-rnp-panels.js opens NCM's page on purpose
const STYLE_ID = 'bncm-lyrics-bridge';
const CONTAINER = '#vinyl-page-container';
const COVER = 'footer .miniVinylWrapper, footer [data-testid="tid_btn_pc_minibar_vinyl"]';
const COLLAPSE = '[data-testid="tid_vinyl_unfold_btn"], .close button';
const DISLIKE_BTN = 'footer [data-testid="tid_fmdislike_btn"]';
const PLAYLIST_BTN = 'footer [data-testid="tid_playbar_playlist_btn"]';
const PROGRESS_MS = 250;
const CHECK_DELAY_MS = 30;
const STOCK_GRACE_MS = 1500; // a shift-click that opened nothing stops letting NCM's page through
const OPEN_ANSWER_MS = 1500; // the injector answers an open at once; without an answer NCM's page opens
const FETCH_HOSTS = /^https:\/\/(music\.163\.com|interface\d*\.music\.163\.com)\//;
const PROGRESS = 'audioplayer.onPlayProgress';
const PLAY_STATE = 'audioplayer.onPlayState';
const LOAD = 'audioplayer.onLoad';
const NCM_MIN = { w: 1056, h: 752 }; // NCM's own window minimum (its module 35 .b), if not found

// NCM's play modes and the order its play-bar button cycles them (app chunk, module 252 .t).
const MODE_OF = { playOrder: 'order', playCycle: 'repeat', playOneCycle: 'one', playRandom: 'random', playAi: 'ai' };
const CYCLE_AI = ['playAi', 'playCycle', 'playOneCycle', 'playRandom', 'playOrder'];
const CYCLE = ['playOrder', 'playCycle', 'playOneCycle', 'playRandom'];
const CYCLE_TOGETHER = ['playCycle', 'playOneCycle', 'playRandom'];
const FM = 'playFm';
const DOLBY = 2999; // resourcePlayingQuality: 128 192 320 999 1999 2999 dolby 3999 4999 5999 6999
const QUALITY_NAME = { 64: '64acc', 128: 'standard', 192: 'higher', 320: 'exhigh', 999: 'lossless', 1999: 'hires',
  2999: 'dolby', 3999: 'jyeffect', 4999: 'jymaster', 5999: 'sky', 6999: 'vivid' };

// NCM's own page stays invisible unless it is meant to show (shift-click, fallback); in the
// fallback path it starts to open before it can be collapsed again.
const STOCK_PAGE_CSS = `
body:not(.${STOCK_CLASS}):not(.${PANEL_CLASS}) ${CONTAINER} { visibility: hidden !important; }
`;

function installLyricsBridge() {
  if (typeof __BNCM_CFG__ === 'undefined' || __BNCM_CFG__['mac.lyricsWindow'] !== 'true') return;
  if (!location.href.startsWith('orpheus://orpheus/app.html')) return;
  if (window.__bncmLyricsBridge) return;

  const post = (m) => {
    try { if (typeof window[POST] === 'function') window[POST](JSON.stringify(m)); } catch { /* injector gone */ }
  };
  const hasClass = (c) => !!document.body?.classList.contains(c);

  // --- NCM's modules (webpack require) ------------------------------------------------------
  // Module ids differ between NCM builds, so the modules are found by their shape.
  let wreq = null;
  function webpackRequire() {
    if (wreq) return wreq;
    const jp = window.webpackJsonp;
    // only once webpack's runtime has taken the array over; a push before would be run later
    if (!Array.isArray(jp) || jp.push === Array.prototype.push) return null;
    const key = `__bncmLyrics${Date.now()}`;
    try { jp.push([[key], { [key]: (m, e, r) => { wreq = r; } }, [[key]]]); } catch { /* not ready */ }
    return wreq;
  }

  const ncm = { app: null, vinyl: null, vinylState: null, minSize: null, playlist: null };
  function scanModules() {
    const r = webpackRequire();
    const cache = r?.c;
    if (!cache) return false;
    for (const id of Object.keys(cache)) {
      const ex = cache[id]?.exports;
      if (!ex || (typeof ex !== 'object' && typeof ex !== 'function')) continue;
      let keys;
      try { keys = Object.keys(ex); } catch { continue; }
      let states = null;
      const subjects = [];
      for (const k of keys) {
        // a getter of a module still evaluating, or a proxy, may throw
        try {
          const v = ex[k];
          if (!v || (typeof v !== 'object' && typeof v !== 'function')) continue;
          if (v.opening === 'opening' && v.closed === 'closed' && v.opened === 'opened') states = v;
          else if (typeof v.next === 'function' && typeof v.getValue === 'function' && typeof v.subscribe === 'function') subjects.push(v);
          else if (!ncm.app && typeof v.getStore === 'function' && typeof v.getDispatch === 'function' && typeof v.getHistory === 'function') ncm.app = v;
          else if (!ncm.minSize && v.minWidth > 0 && v.minHeight > 0 && 'leftSideMinWidth' in v) ncm.minSize = { w: v.minWidth, h: v.minHeight };
          else if (!ncm.playlist && typeof v.openPlaylist === 'function') ncm.playlist = v;
        } catch { /* not one of ours */ }
      }
      if (states && !ncm.vinyl) {
        const values = Object.values(states);
        const s = subjects.find((x) => { try { return values.includes(x.getValue()); } catch { return false; } });
        if (s) { ncm.vinyl = s; ncm.vinylState = states; }
      }
    }
    return !!ncm.vinyl;
  }

  // --- NCM's store -------------------------------------------------------------------------
  let store = null;
  function getStore() {
    if (store) return store;
    const s = ncm.app?.app?._store;
    if (s?.getState && s.dispatch && s.subscribe) return (store = s);
    const start = document.querySelector('footer') || document.getElementById('root');
    const key = start && Object.keys(start).find((k) => k.startsWith('__reactInternalInstance$'));
    for (let f = key && start[key]; f; f = f.return) {
      const fs = f.memoizedProps?.store;
      if (fs?.getState && fs.dispatch) return (store = fs);
    }
    const root = document.getElementById('root')?._reactRootContainer?._internalRoot?.current;
    const queue = root ? [root] : [];
    for (let i = 0; i < queue.length && i < 5000; i++) {
      const f = queue[i];
      const fs = f.memoizedProps?.store;
      if (fs?.getState && fs.dispatch) return (store = fs);
      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
    }
    return null;
  }
  const state = () => getStore()?.getState() || {};
  const playing = () => state().playing || {};
  const dispatch = (action) => getStore()?.dispatch(action);

  // --- reading state -------------------------------------------------------------------------
  const str = (v) => (v == null ? '' : String(v).trim());
  const first = (...vals) => vals.find((v) => v != null && v !== '' && !(Array.isArray(v) && !v.length));

  function trackId(p = playing()) {
    return str(first(p.resourceTrackId, p.onlineResourceId, p.curTrack?.id, p.curPlaying?.trackId));
  }

  function aliasOf(t) {
    const join = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean).join(' / ') : str(v));
    return {
      alias: join(first(t?.alia, t?.alias)),
      trans: join(first(t?.transNames, t?.tns, t?.transName)),
    };
  }

  // side.js shows Dolby Atmos for envSound 'dolby', and otherwise grades `quality` by number as
  // RNPN does (<=192, <=320, <=999, else Hi-Res). NCM 3 has no envSound field; Dolby is 2999.
  function qualityOf(p) {
    const q = Number(p.resourcePlayingQuality);
    const known = p.resourcePlayingQuality != null && p.resourcePlayingQuality !== '' && Number.isFinite(q) && q > 0;
    return {
      quality: known ? String(q) : '',
      qualityName: known ? QUALITY_NAME[q] || '' : '',
      envSound: q === DOLBY ? 'dolby' : '',
      fileType: str(p.trackFileType),
    };
  }

  function readTrack() {
    const p = playing();
    const t = p.curTrack || {};
    const arts = first(p.resourceArtists, t.artists, t.ar) || [];
    const al = first(t.album, t.al) || {};
    // resourceDuration is in seconds, curTrack's in ms
    const dur = Number(p.resourceDuration) > 0 ? Number(p.resourceDuration) : Number(first(t.duration, t.dt) || 0) / 1000;
    const id = trackId(p);
    const q = qualityOf(p);
    const local = q.fileType === 'local';
    return {
      id,
      playId: str(p.playId),
      title: str(first(p.resourceName, t.name)),
      ...aliasOf(t),
      artists: arts.map((a) => ({ id: str(a?.id), name: str(a?.name) })).filter((a) => a.name),
      album: { id: str(al.id), name: str(al.name) },
      duration: Number.isFinite(dur) ? dur : 0,
      cover: str(first(p.resourceCoverUrl, al.picUrl, t.coverUrl)),
      ...q,
      threadId: str(p.resourceCommentThreadId),
      local,
    };
  }

  function readLiked(s = state()) {
    const p = s.playing || {};
    const id = first(p.onlineResourceId, p.resourceTrackId);
    const map = s['async:hostResource']?.likeTracksMap;
    return !!(map && id != null && map[id]);
  }

  function readMode(p = playing()) {
    const m = p.playingMode === FM ? p.lastPlayingMode : p.playingMode;
    return MODE_OF[m] || 'repeat';
  }

  function readVolume(p = playing()) {
    const v = Number(p.playingVolume);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v > 1 ? v / 100 : v)) : 0.5;
  }

  const readRoaming = (p = playing()) => p.playingMode === FM;

  // NCM's own dislike icon (only rendered while roaming), without its clip path (an id that would
  // be duplicated) and fixed size. Kept once found: the button is gone outside roaming.
  let dislikeIcon = '';
  function readDislikeIcon() {
    if (dislikeIcon) return dislikeIcon;
    const svg = document.querySelector(`${DISLIKE_BTN} svg`)?.cloneNode(true);
    if (!svg) return '';
    svg.querySelectorAll('defs').forEach((d) => d.remove());
    svg.querySelectorAll('[clip-path]').forEach((g) => g.removeAttribute('clip-path'));
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    return (dislikeIcon = svg.outerHTML || '');
  }

  // Native play-state events are right; the store's playingState (2 = playing) can be stale after
  // a reload until the first play/pause, so advancing progress counts as playing too.
  let playState = null;
  const readPlaying = () => (playState != null ? playState : playing().playingState === 2);

  function frame() {
    return { x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight };
  }
  function fullscreen() {
    return !!state().app?.isFullScreen || (window.outerWidth >= screen.width && window.outerHeight >= screen.height);
  }

  function snapshot() {
    return { t: 'snapshot', track: readTrack(), playing: readPlaying(), liked: readLiked(), mode: readMode(),
      volume: readVolume(), roaming: readRoaming(), dislikeIcon: readDislikeIcon(), frame: frame(), fullscreen: fullscreen() };
  }

  // --- active: the window shows ----------------------------------------------------------------
  let active = false;
  // false while the open window cannot be seen (covered, screen locked; the page says so): progress
  // waits, the rest still goes (it is rare)
  let drawn = true;
  let last = {};
  function sendIfChanged(key, value, msg) {
    const j = JSON.stringify(value);
    if (last[key] === j) return;
    last[key] = j;
    post(msg);
  }
  const remember = (key, value) => { last[key] = JSON.stringify(value); };

  let slices = {};
  const slicesOf = (s) => ({ p: s.playing, host: s['async:hostResource'], app: s.app });
  let iconTries = 0;
  function checkAll() {
    if (!active) return;
    const s = state();
    const p = s.playing || {};
    const needIcon = readRoaming(p) && !dislikeIcon;
    // only when a slice that matters changed (the store notifies for every dispatch)
    if (!needIcon && slices.p === s.playing && slices.host === s['async:hostResource'] && slices.app === s.app) return;
    slices = slicesOf(s);
    const tr = readTrack();
    sendIfChanged('track', tr, { t: 'track', ...tr });
    sendIfChanged('liked', readLiked(s), { t: 'liked', v: readLiked(s) });
    sendIfChanged('mode', readMode(p), { t: 'mode', v: readMode(p) });
    sendIfChanged('volume', readVolume(p), { t: 'volume', v: readVolume(p) });
    if (playState == null) sendIfChanged('playing', readPlaying(), { t: 'state', playing: readPlaying() });
    const roaming = readRoaming(p);
    const icon = roaming ? readDislikeIcon() : '';
    sendIfChanged('roaming', [roaming, !!icon], icon ? { t: 'roaming', v: roaming, icon } : { t: 'roaming', v: roaming });
    // NCM renders its dislike button a moment after the mode changes
    if (roaming && !icon && iconTries++ < 5) setTimeout(queueCheck, 400);
  }
  let checkQueued = false;
  function queueCheck() {
    if (!active || checkQueued) return;
    checkQueued = true;
    setTimeout(() => { checkQueued = false; checkAll(); }, CHECK_DELAY_MS);
  }

  function setActive(v) {
    active = !!v;
    document.body?.classList.toggle(OPEN_CLASS, active);
    if (!active) return;
    drawn = true;
    const s = snapshot();
    post(s);
    last = {};
    slices = slicesOf(state());
    iconTries = 0;
    remember('track', s.track);
    remember('liked', s.liked);
    remember('mode', s.mode);
    remember('volume', s.volume);
    remember('playing', s.playing);
    remember('roaming', [s.roaming, !!(s.roaming && s.dislikeIcon)]);
    sendProgress(true);
  }

  // --- native events ------------------------------------------------------------------------
  // Progress comes from the channel shim's tap at NCM's full rate (30-50 Hz while playing) and is
  // decimated here, in the event itself: timers are throttled while NCM's page is hidden.
  let prog = null; // { id, pos, at }
  let rawProg = null; // the newest event while the window is closed, parsed only when needed
  let progSentAt = -Infinity;
  function latestProg() {
    if (rawProg) {
      const pos = parseFloat(rawProg.args[1]);
      if (Number.isFinite(pos)) prog = { id: String(rawProg.args[0]), pos, at: rawProg.at };
      rawProg = null;
    }
    return prog;
  }

  function sendProgress(force) {
    const pr = active && drawn && latestProg();
    if (!pr) return;
    const now = performance.now();
    progSentAt = now;
    post({ t: 'progress', id: pr.id, pos: pr.pos + (readPlaying() ? (now - pr.at) / 1000 : 0), wall: Date.now(), force: !!force });
  }

  function onProgress(args) {
    const now = performance.now();
    if (!active || !drawn) { rawProg = { args, at: now }; return; }
    const pos = parseFloat(args[1]);
    if (!Number.isFinite(pos)) return;
    const prev = latestProg();
    const id = String(args[0]);
    prog = { id, pos, at: now };
    if (playState == null && prev && prev.id === id && pos > prev.pos) setPlayState(true);
    const jump = !prev || prev.id !== id || pos < prev.pos - 0.25 || pos > prev.pos + (now - prev.at) / 1000 + 0.75;
    if (jump || now - progSentAt >= PROGRESS_MS) sendProgress(jump);
  }

  function setPlayState(v) {
    playState = v;
    const pr = latestProg();
    if (pr) pr.at = performance.now();
    if (active) { remember('playing', v); post({ t: 'state', playing: v }); }
  }

  function onPlayState(args) {
    const st = String(args[1] || '').split('|')[1];
    if (st === 'pause' || st === 'stop') setPlayState(false);
    else if (st === 'resume' || st === 'play') setPlayState(true);
  }

  function tap(command, args) {
    if (command === PROGRESS) onProgress(args);
    else if (command === PLAY_STATE) onPlayState(args);
    else if (command === LOAD) queueCheck();
  }

  // --- opening ------------------------------------------------------------------------------
  let opening = false;
  let fallback = false; // no window to show: NCM's own page opens as it would without us
  let unanswered = null;
  let lost = false; // the fallback is the watchdog's: the injector did not answer an open
  function requestOpen() {
    if (opening) return;
    opening = true;
    setTimeout(() => { opening = false; }, 800);
    if (!greeted) hello(); // a click before boot is done: the injector takes commands from a bridge that said hello
    post({ t: 'open', frame: frame(), fullscreen: fullscreen() });
    // The injector answers with active or fallback at once. No answer: it is gone (stopped,
    // crashed) and the binding leads nowhere, so NCM's own page opens, now and from then on.
    clearTimeout(unanswered);
    unanswered = setTimeout(() => { detach(); openStock(); lost = true; }, OPEN_ANSWER_MS);
  }
  const answered = () => { clearTimeout(unanswered); unanswered = null; };
  // The answer came after all (the injector was only slow, not gone): later opens are the window's
  // again. NCM's page, opened meanwhile, stays visible until it closes (endStock).
  function revive() {
    if (!lost) return;
    lost = false;
    fallback = false;
  }
  const letThrough = () => fallback || hasClass(STOCK_CLASS) || hasClass(PANEL_CLASS);
  // after a fallback every open is NCM's own page, so it stays visible
  const endStock = () => { if (!fallback) document.body?.classList.remove(STOCK_CLASS); };
  function toStock() {
    answered();
    lost = false;
    fallback = true;
    document.body?.classList.add(STOCK_CLASS);
  }
  const openStock = () => dispatch({ type: 'playing/openVinylPage' });
  // The window is gone for good (the injector stopped): nothing more is sent, NCM's page is its own
  // again, and the play bar is no longer slowed.
  function detach() {
    toStock();
    setActive(false);
    unhideNcm(); // the injector is going away: NCM's window must not stay hidden
  }

  function clickEl(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }

  // The one choke point: NCM's vinyl-page subject. Every opener (the play bar's cover, menus, the
  // tray, the desktop lyric, heart mode, FM cards, plugins) calls its next('opening').
  let hooked = false;
  function hookVinyl() {
    const vs = ncm.vinyl;
    if (!vs || hooked) return hooked;
    const OPENING = ncm.vinylState.opening;
    const CLOSED = ncm.vinylState.closed;
    const orig = vs.next;
    vs.next = function next(v) {
      if (v === OPENING && !letThrough()) { requestOpen(); return undefined; }
      if (v === CLOSED) endStock();
      return orig.call(this, v);
    };
    hooked = true;
    return true;
  }
  const vinylValue = () => { try { return ncm.vinyl?.getValue(); } catch { return null; } };

  // The play bar's cover. With the subject hooked a plain click needs nothing here: NCM's own
  // handler runs into the hook. Shift-click opens NCM's own page (百科 etc. in NCM's own look).
  document.addEventListener('click', (e) => {
    if (fallback) return;
    const t = e.target instanceof Element && e.target.closest(COVER);
    if (!t) return;
    if (e.shiftKey) {
      document.body.classList.add(STOCK_CLASS);
      // NCM's cover handler is throttled; if it opened nothing, stop letting its page through
      setTimeout(() => {
        const v = hooked ? vinylValue() : getStore()?.getState()['page:vinylPage']?.pageState;
        if (v === 'closed' || v == null) endStock();
      }, STOCK_GRACE_MS);
      return;
    }
    if (hooked) return;
    e.stopPropagation();
    e.preventDefault();
    requestOpen();
  }, true);

  // Without the hook: NCM's page starts to open, hidden by STOCK_PAGE_CSS; close it again and
  // open the window.
  let vinylWas = null;
  let collapsing = false;
  let lastStore = null;
  function onStore() {
    if (active) queueCheck();
    if (hooked) return;
    const s = getStore()?.getState();
    if (!s || s === lastStore) return;
    lastStore = s;
    const v = s['page:vinylPage']?.pageState;
    if (v === vinylWas) return;
    const was = vinylWas;
    vinylWas = v;
    if (v === 'closed') endStock();
    if (letThrough()) return;
    if ((v === 'opening' || v === 'opened') && was !== 'opening' && was !== 'opened') {
      requestOpen();
      collapseStock();
    }
  }

  function collapseStock() {
    if (collapsing) return;
    collapsing = true;
    let tries = 0;
    const step = () => {
      const st = getStore()?.getState()['page:vinylPage']?.pageState;
      // NCM's page may be meant to show by now (no answer to the open)
      if (st === 'closed' || st === 'closing' || letThrough() || tries++ > 12) { collapsing = false; return; }
      const b = document.querySelector(CONTAINER)?.querySelector(COLLAPSE);
      if (b && st === 'opened') clickEl(b);
      setTimeout(step, 250);
    };
    setTimeout(step, 50);
  }

  // --- commands -------------------------------------------------------------------------------
  const rand = () => Math.random().toString(36).slice(2, 8);
  function nativeCall(cmd, params) {
    const adapter = window.legacyNativeCmder?._envAdapter;
    if (adapter?.callAdapter) return adapter.callAdapter(cmd, () => {}, params);
    return window.channel?.call(cmd, () => {}, params);
  }
  const winCall = (cmd, params) => window.channel?.call(cmd, () => {}, params);

  function seek(sec) {
    const id = trackId();
    if (!id || !Number.isFinite(sec)) return false;
    const to = Math.max(0, sec);
    if (getStore()) dispatch({ type: 'playing/setPlayingPosition', payload: { duration: to } });
    else nativeCall('audioplayer.seek', [id, `${id}|seek|${rand()}`, to]);
    const pr = latestProg();
    if (pr) { prog = { id: pr.id, pos: to, at: performance.now() }; sendProgress(true); }
    return true;
  }

  function nextMode() {
    const s = state();
    const p = s.playing || {};
    if (p.playingMode === FM) {
      // NCM's button is disabled while roaming, except for the single/endless FM switch
      if (s.abtest?.['PH-PC-FM-Single']?.expGroupName !== 't1') return false;
      dispatch({ type: 'fmPlaying/switchPlayingMode', payload: {} });
      return true;
    }
    const lt = s['async:listenTogether'];
    const together = !!(lt?.roomInfo?.roomId && lt.status !== 'alone');
    const heart = p.isCanHeartBeat ?? true;
    const list = together ? CYCLE_TOGETHER : heart ? CYCLE_AI : CYCLE;
    const i = Math.max(list.indexOf(p.playingMode), 0);
    const mode = list[i === list.length - 1 ? 0 : i + 1];
    dispatch({ type: 'playing/switchPlayingMode', payload: { playingMode: mode, triggerScene: 'miniBar', HeartBeatFlage: heart } });
    return true;
  }

  // The FM track NCM's dislike button hands to its blacklist modal: `current` of the scene's FM
  // state, picked as NCM's own selector does (app chunk, module 93 .a).
  function currentFmTrack() {
    const fm = state().fmPlaying;
    if (!fm) return null;
    const st = fm.currentScene === 'fm'
      ? (fm.currentMode ? fm.privateFmByMode?.[fm.currentMode] : fm.privateFm)
      : fm.zoneFm?.[fm.currentId];
    return st?.current || st?.fmTracks?.[st.currentIndex] || null;
  }

  function dislike() {
    const s = state();
    if (!readRoaming(s.playing || {})) return false;
    const resource = currentFmTrack();
    if (resource && s.abtest?.['PH-PC-Blacklist']?.expGroupName === 't1') {
      dispatch({ type: 'playing/openDislikeModal', payload: { resource, resourceType: 'track', scene: s.fmPlaying?.currentScene } });
      return true;
    }
    // the other branches need the click event (a context menu at the pointer)
    const b = document.querySelector(DISLIKE_BTN);
    if (b) clickEl(b);
    return !!b;
  }

  function openPlaylist() {
    if (ncm.playlist) {
      try { ncm.playlist.openPlaylist(); return true; } catch { /* the button below */ }
    }
    const b = document.querySelector(PLAYLIST_BTN);
    if (b) clickEl(b);
    return !!b;
  }

  function history() {
    try { const h = ncm.app?.getHistory?.(); if (h?.push) return h; } catch { /* the fiber walk */ }
    const root = document.getElementById('root')?._reactRootContainer?._internalRoot?.current;
    const queue = root ? [root] : [];
    for (let i = 0; i < queue.length && i < 3000; i++) {
      const f = queue[i];
      const h = f.memoizedProps?.history;
      if (h?.push) return h;
      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
    }
    return null;
  }

  // RNPN's links are NCM 2 hashes (#/m/artist/?id=1), the only form the window sends; NCM 3 routes
  // them through its link action, which is what its own menus run. Anything else is refused.
  const LINK_TYPES = { artist: 'artist', album: 'album', playlist: 'playlist', personal: 'user', user: 'user' };
  function navigate(hash) {
    const m = /^#?\/m\/(\w+)\/?\?(?:id|uid)=(\d+)$/.exec(String(hash || ''));
    if (!m) return false;
    if (LINK_TYPES[m[1]]) {
      dispatch({ type: 'async:action/doAction', payload: { actionId: 'link', data: { resource: { id: m[2] }, resourceType: LINK_TYPES[m[1]] } } });
      return true;
    }
    if (m[1] === 'song') return pushRoute(`/comment/R_SO_4_${m[2]}`);
    return false;
  }
  // An NCM 3 path, as it is: only for actions that check it against their own list (commentLink).
  function pushRoute(path) {
    const hist = history();
    if (!hist) return false;
    hist.push(path);
    return true;
  }

  async function doFetch(url) {
    if (!FETCH_HOSTS.test(url)) throw new Error('host not allowed');
    const r = await fetch(url, { credentials: 'include' });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return text; }
  }

  // Put NCM's window where the lyrics window was (`frame`, top-left origin; `cocoa`, the same with a
  // bottom-left origin, which winhelper.setWindowPosition uses). That call also sets NCM's minimum
  // size to the size given (and may re-centre first), so it is made only when the frame differs,
  // and NCM's own minimum is put back after it. It does not raise NCM.
  function moveNcm(m) {
    const f = m.cocoa;
    const top = m.frame;
    const same = top && [top.x - window.screenX, top.y - window.screenY, top.w - window.outerWidth, top.h - window.outerHeight]
      .every((d) => Number.isFinite(d) && Math.abs(d) <= 1);
    if (!same && f && [f.x, f.y, f.w, f.h].every(Number.isFinite)) {
      winCall('winhelper.setWindowPosition', [{ x: Math.round(f.x), y: Math.round(f.y), width: Math.round(f.w), height: Math.round(f.h), topmost: false }]);
      const min = ncm.minSize || NCM_MIN;
      winCall('winhelper.setWindowSizeLimit', [{ x: min.w, y: min.h }, { x: 0, y: 0 }]);
    }
  }
  // Hand the screen back to NCM: its window where the lyrics window was, raised.
  function showNcm(m) {
    moveNcm(m);
    unhideNcm();
    winCall('winhelper.bringWindowToTop', []);
    return true;
  }
  // While the lyrics window is in full screen (its own Space) NCM's window is hidden, as NCM's red
  // button hides it, so the desktop does not keep a second player; it comes back when full screen ends.
  let ncmHidden = false;
  function hideNcm() {
    ncmHidden = true;
    winCall('winhelper.showWindow', ['hide']);
    return true;
  }
  function unhideNcm(m) {
    if (!ncmHidden) return false;
    ncmHidden = false;
    if (m) moveNcm(m);
    winCall('winhelper.showWindow', ['show']);
    return true;
  }

  let greeted = false;
  function hello() {
    greeted = true;
    post({ t: 'hello' });
  }

  const reply = (m, ok, v) => post(ok ? { t: 'reply', rid: m.rid, ok: true, data: v } : { t: 'reply', rid: m.rid, ok: false, error: String(v?.message || v) });

  const commands = {
    hello: () => { hello(); return true; },
    snapshot: () => { post(snapshot()); return true; },
    active: (m) => { if (m.v) { answered(); revive(); } setActive(m.v); return true; },
    drawn: (m) => {
      const was = drawn;
      drawn = !!m.v;
      if (drawn && !was) sendProgress(true); // the page's clock catches up
      return true;
    },
    toggle: () => { dispatch({ type: 'playing/switchResumeOrPause', payload: { triggerScene: 'miniBar' } }); return true; },
    prev: () => { dispatch({ type: 'playingList/jump2Track', payload: { flag: -1, type: 'call', triggerScene: 'miniBar' } }); return true; },
    next: () => { dispatch({ type: 'playingList/jump2Track', payload: { flag: 1, type: 'call', triggerScene: 'miniBar' } }); return true; },
    seek: (m) => seek(Number(m.sec)),
    volume: (m) => {
      const v = Math.min(1, Math.max(0, Number(m.v)));
      if (!Number.isFinite(v)) return false;
      if (getStore()) dispatch({ type: 'playing/setVolume', payload: { volume: v } });
      else nativeCall('audioplayer.setVolume', ['', '', v]);
      remember('volume', v); // the store echoes it; the window has it already
      return true;
    },
    like: () => { dispatch({ type: 'async:hostResource/setLikeCurPlayingTrack', payload: { from: 'miniBar' } }); return true; },
    mode: () => nextMode(),
    playlist: () => openPlaylist(),
    dislike: () => dislike(),
    nav: (m) => navigate(m.hash),
    fetch: async (m) => {
      try { reply(m, true, await doFetch(String(m.url))); } catch (e) { reply(m, false, e); }
      return true;
    },
    // The cover sampled to 32x32 the way RNPN samples it, by this page's Chromium (accent.js in the
    // window explains why not by WebKit). RGBA bytes, base64.
    accentPixels: (m) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = 32;
          c.height = 32;
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, 32, 32);
          const d = g.getImageData(0, 0, 32, 32).data;
          let bin = '';
          for (let i = 0; i < d.length; i++) bin += String.fromCharCode(d[i]);
          reply(m, true, btoa(bin));
        } catch (e) {
          reply(m, false, e);
        }
      };
      img.onerror = () => reply(m, false, 'cover did not load');
      img.src = String(m.url);
      return true;
    },
    rnpSettings: (m) => {
      const ls = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith('refined-now-playing-')) ls[k.slice('refined-now-playing-'.length)] = localStorage.getItem(k);
      }
      reply(m, true, ls);
      return true;
    },
    ncmAction: async (m) => {
      const run = Object.prototype.hasOwnProperty.call(actions, m.action) && actions[m.action];
      try {
        if (typeof run !== 'function') throw new Error(`no action ${m.action}`);
        const data = await run(m, helpers);
        if (m.rid) reply(m, true, data ?? null);
        return true;
      } catch (e) {
        if (m.rid) reply(m, false, e);
        return false;
      }
    },
    showNcm,
    // where the lyrics window was, without raising it first: a minimized window comes back there
    minimizeNcm: (m) => { moveNcm(m); winCall('winhelper.showWindow', ['minimize']); return true; },
    fallback: () => { toStock(); openStock(); return true; },
    // the injector is shutting down while NCM keeps running
    detach: () => { detach(); return true; },
    hideNcm: () => hideNcm(),
    unhideNcm: (m) => unhideNcm(m),
  };

  // Panel and menu actions handed to NCM: lyrics-actions-*.js preludes register them in
  // window.__bncmLyricsActions as name -> (msg, helpers) => plain data (or a promise of it).
  const actions = (window.__bncmLyricsActions ||= {});
  const helpers = { getStore, dispatch, post, clickEl, nativeCall, navigate, pushRoute, readTrack, trackId, require: webpackRequire };

  window.__bncmLyricsBridge = {
    cmd(m) {
      const fn = m && Object.prototype.hasOwnProperty.call(commands, m.c) && commands[m.c];
      if (!fn) return false;
      try { return fn(m); } catch (e) { console.error('[BetterNCM] lyrics bridge command failed', m.c, e); return false; }
    },
    actions,
    get hooked() { return hooked; },
  };

  // --- start ----------------------------------------------------------------------------------
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STOCK_PAGE_CSS;
  // a prelude runs before the document has an element to put it in
  const addStyle = () => (document.head || document.documentElement).appendChild(style);
  if (document.documentElement) addStyle();
  else document.addEventListener('DOMContentLoaded', addStyle, { once: true });

  if (typeof window.__bncmChannelTap === 'function') {
    window.__bncmChannelTap(tap);
  } else if (window.channel?.registerCall) {
    // the shim's throttled plugin listeners (10 Hz) still do for 4 Hz
    window.channel.registerCall(PROGRESS, (...a) => onProgress(a));
    window.channel.registerCall(PLAY_STATE, (...a) => onPlayState(a));
  } else {
    console.warn('[BetterNCM] lyrics bridge: no channel to listen on');
  }

  let bootTries = 0;
  let scans = 0; // a scan walks every loaded module; stop trying when the subject is not there
  const boot = setInterval(() => {
    bootTries++;
    try {
      if (!hooked && scans < 40 && webpackRequire()?.c) { scans++; if (scanModules()) hookVinyl(); }
    } catch (e) { console.warn('[BetterNCM] lyrics bridge: module scan failed', e); }
    const s = getStore();
    if (!s) return;
    if (!hooked && bootTries < 20) return; // the modules come with the store; give them a moment
    clearInterval(boot);
    if (!hooked) console.warn('[BetterNCM] lyrics bridge: NCM\'s vinyl page subject not found, watching the store');
    vinylWas = s.getState()['page:vinylPage']?.pageState ?? null;
    s.subscribe(onStore);
    hello();
  }, 300);
}

installLyricsBridge();
