// The lyrics window's bridge in NCM's page (LYRICS-WINDOW.md; config mac.lyricsWindow).
//
// It has no UI. While the window is closed it only watches for the lyric page being asked for:
// a click on the play bar's cover, or NCM's own now-playing page starting to open by any other
// way (menus, shortcuts, sagas). While the window shows, it sends the track, the play state and
// progress at 4 Hz, and runs the window's commands in NCM's page.
//
// Messages go out through the CDP binding __bncmLyricsPost (src/lyrics-window.mjs); commands come
// in as window.__bncmLyricsBridge.cmd(msg), evaluated by the injector.

const POST = '__bncmLyricsPost';
const OPEN_CLASS = 'bncm-lyrics-open'; // the window covers NCM's; channel-shim.js slows NCM's play bar
const STYLE_ID = 'bncm-lyrics-bridge';
const CONTAINER = '#vinyl-page-container';
const COLLAPSE = '[data-testid="tid_vinyl_unfold_btn"], .close button';
const PROGRESS_MS = 250;
const FETCH_HOSTS = /^https:\/\/(music\.163\.com|interface\d*\.music\.163\.com)\//;
const PROGRESS = 'audioplayer.onPlayProgress';
const PLAY_STATE = 'audioplayer.onPlayState';
const LOAD = 'audioplayer.onLoad';
const VOLUME = 'audioplayer.onVolume';

// Shift-click on the play bar's cover still opens NCM's own page (百科 etc. in NCM's own look).
const STOCK_PAGE_CSS = `
body:not(.bncm-stock-vinyl) ${CONTAINER} { visibility: hidden !important; }
`;

function installLyricsBridge() {
  if (typeof __BNCM_CFG__ === 'undefined' || __BNCM_CFG__['mac.lyricsWindow'] !== 'true') return;
  if (!location.href.startsWith('orpheus://orpheus/app.html')) return;
  if (window.__bncmLyricsBridge) return;

  const post = (m) => {
    try { if (typeof window[POST] === 'function') window[POST](JSON.stringify(m)); } catch { /* injector gone */ }
  };

  // --- NCM's store -------------------------------------------------------------------------
  let store = null;
  function getStore() {
    if (store) return store;
    const start = document.querySelector('footer') || document.getElementById('root');
    const key = start && Object.keys(start).find((k) => k.startsWith('__reactInternalInstance$'));
    for (let f = key && start[key]; f; f = f.return) {
      const s = f.memoizedProps?.store;
      if (s?.getState && s.dispatch) return (store = s);
    }
    const root = document.getElementById('root')?._reactRootContainer?._internalRoot?.current;
    const queue = root ? [root] : [];
    for (let i = 0; i < queue.length && i < 5000; i++) {
      const f = queue[i];
      const s = f.memoizedProps?.store;
      if (s?.getState && s.dispatch) return (store = s);
      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
    }
    return null;
  }
  const playing = () => getStore()?.getState().playing || {};
  const dispatch = (action) => getStore()?.dispatch(action);

  // --- reading state -------------------------------------------------------------------------
  const str = (v) => (v == null ? '' : String(v).trim());
  const first = (...vals) => vals.find((v) => v != null && v !== '' && !(Array.isArray(v) && !v.length));

  function trackId(p = playing()) {
    return str(first(p.resourceTrackId, p.originFromTrack?.lrcid, p.originFromTrack?.track?.tid, p.curTrack?.id, p.id, p.data?.id));
  }

  function aliasOf(t) {
    const join = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean).join(' / ') : str(v));
    return {
      alias: join(first(t?.alia, t?.alias)),
      trans: join(first(t?.transNames, t?.tns, t?.transName)),
    };
  }

  function readTrack() {
    const p = playing();
    const t = p.curTrack || p.data || {};
    const arts = first(p.resourceArtists, p.artists, t.artists, t.ar, p.data?.artists) || [];
    const al = first(t.album, t.al, p.data?.album) || {};
    let dur = Number(first(p.resourceDuration, p.duration, p.dt, t.duration, t.dt, p.data?.duration) || 0);
    if (dur > 1000) dur /= 1000;
    return {
      id: trackId(p),
      title: str(first(p.resourceName, p.name, t.name, p.data?.name)),
      ...aliasOf(t),
      artists: arts.map((a) => ({ id: str(a?.id), name: str(a?.name) })).filter((a) => a.name),
      album: { id: str(al.id), name: str(al.name) },
      duration: dur,
      cover: str(first(p.resourceCoverUrl, t.album?.picUrl, t.al?.picUrl, t.coverUrl, p.data?.album?.picUrl)),
      quality: str(p.resourcePlayingQuality),
      envSound: str(p.resourcePlayingEnvSound),
      fileType: str(p.trackFileType),
      threadId: str(p.resourceCommentThreadId),
      local: p.trackFileType === 'local',
    };
  }

  function readLiked() {
    try {
      const s = getStore().getState();
      const id = s.playing?.onlineResourceId ?? s.playing?.resourceTrackId;
      const map = s['async:hostResource']?.likeTracksMap;
      if (map && id != null) return !!map[id];
    } catch { /* fall through */ }
    return false;
  }

  function readPlayerSetting() {
    try { return JSON.parse(localStorage.getItem('NM_SETTING_PLAYER') || '{}'); } catch { return {}; }
  }

  function footerButtons() {
    return [...document.querySelectorAll('footer button')].filter((b) => b.offsetParent);
  }
  const labelOf = (el) => [el.getAttribute('aria-label'), el.title, el.getAttribute('data-testid'), el.className].map(str).join(' ').toLowerCase();

  function modeButton() {
    return document.querySelector('footer > * > * > .middle > *:nth-child(1) > button:nth-child(1)')
      || footerButtons().find((b) => /mode|循环|随机|顺序|单曲|心动|shuffle|repeat|loop|order/.test(labelOf(b)));
  }

  function readMode() {
    const b = modeButton();
    const l = b ? labelOf(b) : '';
    if (/心动|heart|ai/.test(l)) return 'ai';
    if (/单曲|one|single/.test(l)) return 'one';
    if (/随机|shuffle|random/.test(l)) return 'random';
    if (/顺序|order|sequence/.test(l)) return 'order';
    if (/循环|repeat|loop/.test(l)) return 'repeat';
    const m = str(readPlayerSetting().mode).toLowerCase();
    if (/playonce|once|sequence/.test(m)) return 'order';
    if (/playcycle|singleloop|single|repeatone/.test(m)) return 'one';
    if (/random|shuffle/.test(m)) return 'random';
    if (/order|loop|repeat/.test(m)) return 'repeat';
    return 'repeat';
  }

  let volume = null;
  function readVolume() {
    if (volume != null) return volume;
    const s = readPlayerSetting();
    const v = Number(first(s.volume, s.vol, s.volumeValue, playing().playingVolume));
    return Number.isFinite(v) ? (v > 1 ? v / 100 : v) : 0.5;
  }

  const readRoaming = () => !!document.querySelector('footer [data-testid="tid_fmdislike_btn"]');

  let playState = null; // from native events; the store's playingState is stale after a reload
  const readPlaying = () => (playState != null ? playState : playing().playingState === 2);

  function frame() {
    return { x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight };
  }

  function snapshot() {
    return { t: 'snapshot', track: readTrack(), playing: readPlaying(), liked: readLiked(), mode: readMode(),
      volume: readVolume(), roaming: readRoaming(), frame: frame() };
  }

  // --- active: the window shows ----------------------------------------------------------------
  let active = false;
  let last = {};
  function sendIfChanged(key, value, msg) {
    const j = JSON.stringify(value);
    if (last[key] === j) return;
    last[key] = j;
    post(msg);
  }

  let pollTimer = 0;
  function checkAll() {
    if (!active) return;
    const tr = readTrack();
    sendIfChanged('track', tr, { t: 'track', ...tr });
    sendIfChanged('liked', readLiked(), { t: 'liked', v: readLiked() });
    sendIfChanged('mode', readMode(), { t: 'mode', v: readMode() });
    sendIfChanged('roaming', readRoaming(), { t: 'roaming', v: readRoaming() });
  }
  let checkQueued = false;
  function queueCheck() {
    if (!active || checkQueued) return;
    checkQueued = true;
    setTimeout(() => { checkQueued = false; checkAll(); }, 30);
  }

  function setActive(v) {
    active = !!v;
    document.body?.classList.toggle(OPEN_CLASS, active);
    clearInterval(pollTimer);
    last = {};
    if (active) {
      post(snapshot());
      const s = snapshot();
      last = { track: JSON.stringify(s.track), liked: JSON.stringify(s.liked), mode: JSON.stringify(s.mode), roaming: JSON.stringify(s.roaming) };
      // the mode and like buttons change without a store change now and then; a slow poll is enough
      pollTimer = setInterval(checkAll, 1500);
      sendProgress(true);
    }
  }

  // --- native events ------------------------------------------------------------------------
  let prog = null; // { id, pos, at }
  let progSentAt = -Infinity;
  let progTimer = 0;
  function sendProgress(force) {
    if (!active || !prog) return;
    clearTimeout(progTimer);
    progTimer = 0;
    progSentAt = performance.now();
    post({ t: 'progress', id: prog.id, pos: prog.pos + (playState ? (performance.now() - prog.at) / 1000 : 0), wall: Date.now(), force: !!force });
  }

  function onProgress(args) {
    const now = performance.now();
    const id = String(args[0]);
    const pos = parseFloat(args[1]);
    if (!Number.isFinite(pos)) return;
    const prev = prog;
    prog = { id, pos, at: now };
    if (!active) return;
    const jump = !prev || prev.id !== id || pos < prev.pos - 0.25 || pos > prev.pos + (now - prev.at) / 1000 + 0.75;
    if (jump || now - progSentAt >= PROGRESS_MS) { sendProgress(jump); return; }
    if (!progTimer) progTimer = setTimeout(() => sendProgress(false), PROGRESS_MS - (now - progSentAt));
  }

  function onPlayState(args) {
    const st = String(args[1] || '').split('|')[1];
    if (st === 'pause' || st === 'stop') playState = false;
    else if (st === 'resume' || st === 'play') playState = true;
    else return;
    if (prog) prog.at = performance.now();
    if (active) post({ t: 'state', playing: playState });
  }

  function onVolume(args) {
    for (let i = args.length - 1; i >= 0; i--) {
      let v = args[i];
      if (v && typeof v === 'object') v = first(v.volume, v.vol, v.value, v.currentVolume);
      v = Number(v);
      if (Number.isFinite(v) && v >= 0 && v <= 100) {
        volume = v > 1 ? v / 100 : v;
        if (active) post({ t: 'volume', v: volume });
        return;
      }
    }
  }

  function tap(command, args) {
    if (command === PROGRESS) onProgress(args);
    else if (command === PLAY_STATE) onPlayState(args);
    else if (command === VOLUME) onVolume(args);
    else if (command === LOAD) queueCheck();
  }

  // --- opening ------------------------------------------------------------------------------
  let opening = false;
  let fallback = false;
  function requestOpen() {
    if (opening) return;
    opening = true;
    setTimeout(() => { opening = false; }, 800);
    post({ t: 'open', frame: frame(), fullscreen: window.outerWidth >= screen.width && window.outerHeight >= screen.height });
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

  // The play bar's cover: open the window instead of NCM's page (shift-click: NCM's page).
  document.addEventListener('click', (e) => {
    if (fallback) return;
    const t = e.target instanceof Element && e.target.closest('footer .miniVinylWrapper');
    if (!t) return;
    if (e.shiftKey) { document.body.classList.add('bncm-stock-vinyl'); return; }
    e.stopPropagation();
    e.preventDefault();
    requestOpen();
  }, true);

  // Every other way in (menus, shortcuts, NCM's own code): NCM's page starts to open, hidden by
  // STOCK_PAGE_CSS; close it again and open the window.
  let vinylWas = null;
  let collapsing = false;
  function onStore() {
    queueCheck();
    const v = getStore()?.getState()['page:vinylPage']?.pageState;
    if (v === vinylWas) return;
    const was = vinylWas;
    vinylWas = v;
    if (v === 'closed') document.body.classList.remove('bncm-stock-vinyl');
    if (fallback || document.body.classList.contains('bncm-stock-vinyl')) return;
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
      if (st === 'closed' || st === 'closing' || tries++ > 12) { collapsing = false; return; }
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

  function seek(sec) {
    const id = trackId();
    if (!id || !Number.isFinite(sec)) return;
    nativeCall('audioplayer.seek', [id, `${id}|seek|${rand()}`, Math.max(0, sec)]);
    if (prog) { prog = { id, pos: sec, at: performance.now() }; sendProgress(true); }
  }

  function navigate(hash) {
    const h = String(hash || '');
    if (!/^#?\/m\//.test(h)) return false;
    const pathq = h.replace(/^#/, '');
    // NCM's router (react-router's history) when it can be found, else the hash
    const root = document.getElementById('root')?._reactRootContainer?._internalRoot?.current;
    const queue = root ? [root] : [];
    for (let i = 0; i < queue.length && i < 3000; i++) {
      const f = queue[i];
      const hist = f.memoizedProps?.history;
      if (hist?.push) { hist.push(pathq); return true; }
      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
    }
    location.hash = pathq;
    return true;
  }

  async function doFetch(url) {
    if (!FETCH_HOSTS.test(url)) throw new Error('host not allowed');
    const r = await fetch(url, { credentials: 'include' });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return text; }
  }

  const commands = {
    snapshot: () => { post(snapshot()); return true; },
    active: (m) => { setActive(m.v); return true; },
    toggle: () => { dispatch({ type: 'playing/switchResumeOrPause', payload: { triggerScene: 'miniBar' } }); return true; },
    prev: () => { dispatch({ type: 'playingList/jump2Track', payload: { flag: -1, type: 'call', triggerScene: 'miniBar' } }); return true; },
    next: () => { dispatch({ type: 'playingList/jump2Track', payload: { flag: 1, type: 'call', triggerScene: 'miniBar' } }); return true; },
    seek: (m) => { seek(Number(m.sec)); return true; },
    volume: (m) => {
      const v = Math.min(1, Math.max(0, Number(m.v)));
      if (!Number.isFinite(v)) return false;
      nativeCall('audioplayer.setVolume', ['', '', v]);
      volume = v;
      return true;
    },
    like: () => {
      dispatch({ type: 'async:hostResource/setLikeCurPlayingTrack', payload: {} });
      for (const ms of [120, 400, 900]) setTimeout(checkAll, ms);
      return true;
    },
    mode: () => {
      const b = modeButton();
      if (b) clickEl(b);
      for (const ms of [80, 300]) setTimeout(checkAll, ms);
      return !!b;
    },
    playlist: () => {
      const b = footerButtons().find((x) => /playlist|播放列表|列表/.test(labelOf(x)));
      if (b) clickEl(b);
      return !!b;
    },
    dislike: () => {
      const b = document.querySelector('footer [data-testid="tid_fmdislike_btn"]');
      if (b) clickEl(b);
      return !!b;
    },
    nav: (m) => navigate(m.hash),
    fetch: async (m) => {
      try { post({ t: 'reply', rid: m.rid, ok: true, data: await doFetch(String(m.url)) }); }
      catch (e) { post({ t: 'reply', rid: m.rid, ok: false, error: String(e?.message || e) }); }
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
          post({ t: 'reply', rid: m.rid, ok: true, data: btoa(bin) });
        } catch (e) {
          post({ t: 'reply', rid: m.rid, ok: false, error: String(e?.message || e) });
        }
      };
      img.onerror = () => post({ t: 'reply', rid: m.rid, ok: false, error: 'cover did not load' });
      img.src = String(m.url);
      return true;
    },
    rnpSettings: (m) => {
      const ls = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith('refined-now-playing-')) ls[k.slice('refined-now-playing-'.length)] = localStorage.getItem(k);
      }
      post({ t: 'reply', rid: m.rid, ok: true, data: ls });
      return true;
    },
    ncmAction: (m) => {
      const run = actions[m.action];
      let data = null;
      let ok = false;
      try { data = run ? run(m) : null; ok = !!run; } catch (e) { data = String(e?.message || e); }
      if (m.rid) post({ t: 'reply', rid: m.rid, ok, data });
      return ok;
    },
    // Hand the screen back to NCM: put its window where the lyrics window was and raise it.
    // `cocoa` is the frame with a bottom-left origin, which winhelper.setWindowPosition uses.
    showNcm: (m) => {
      const f = m.cocoa;
      if (f && [f.x, f.y, f.w, f.h].every(Number.isFinite)) {
        window.channel?.call('winhelper.setWindowPosition', () => {}, [{ x: Math.round(f.x), y: Math.round(f.y), width: Math.round(f.w), height: Math.round(f.h), topmost: false }]);
      }
      window.channel?.call('winhelper.bringWindowToTop', () => {}, []);
      return true;
    },
    minimizeNcm: () => { window.channel?.call('winhelper.showWindow', () => {}, ['minimize']); return true; },
    fallback: () => {
      fallback = true;
      document.body.classList.add('bncm-stock-vinyl');
      dispatch({ type: 'playing/openVinylPage' });
      return true;
    },
  };

  // Panel and menu actions handed to NCM (filled in by the panels; each returns plain data).
  const actions = {
    playTrack: (m) => {
      dispatch({ type: 'playing/playTrack', payload: { id: String(m.id), triggerScene: 'miniBar' } });
      return true;
    },
  };

  window.__bncmLyricsBridge = {
    cmd(m) {
      const fn = m && commands[m.c];
      if (!fn) return false;
      try { return fn(m); } catch (e) { console.error('[BetterNCM] lyrics bridge command failed', m.c, e); return false; }
    },
    actions,
  };

  // --- start ----------------------------------------------------------------------------------
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STOCK_PAGE_CSS;
  (document.head || document.documentElement).appendChild(style);

  if (typeof window.__bncmChannelTap === 'function') window.__bncmChannelTap(tap);
  else console.warn('[BetterNCM] lyrics bridge: channel shim taps unavailable');

  const boot = setInterval(() => {
    const s = getStore();
    if (!s) return;
    clearInterval(boot);
    vinylWas = s.getState()['page:vinylPage']?.pageState ?? null;
    s.subscribe(onStore);
    post({ t: 'hello' });
  }, 300);
}

installLyricsBridge();
