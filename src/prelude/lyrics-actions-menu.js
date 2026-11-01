// The lyrics window's "···" menu, NCM's side (LYRICS-WINDOW.md, ncmAction; the menu is
// resources/lyrics/web/js/menu.js). Each item runs the way NCM's own play-bar menu runs it
// (async:action/doAction with the current track, scene newMiniBar), or the effect NCM's own control
// dispatches.
//
// menuInfo:  the current speed, and whether NCM offers 播放倍速 (its menu shows it only in the
//            PH-MAC-playSpeed experiment group t1).
// menuSpeed: playing/switchPlayingSpeed, as NCM's speed popover.
// menuLink:  歌手 / 专辑, NCM's `link` action (the window collapses as it is sent).
// menuRun:   收藏到歌单 / 下载 / 分享. They open NCM's own dialogs in its window, which the lyrics
//            window has just handed the screen back to; NCM is raised and activated first (the
//            click happened in another app), as NCM's activeWindow does for its native menus.

(() => {
  const actions = (window.__bncmLyricsActions ||= {});
  const RUN = new Set(['favorite', 'download', 'share']);
  const RAISE_MS = 150; // lets the window come forward before the dialog opens in it

  const isVoice = (p) => /voice|program|audio/i.test(String(p?.resourceType || ''));

  function current(getStore) {
    const p = getStore()?.getState().playing || {};
    const cp = p.curPlaying || {};
    const local = cp.localTrack && Object.keys(cp.localTrack).length ? cp.localTrack : null;
    const resource = local ? { ...local, ...(cp.track || {}) } : cp.track;
    return { p, resource, resourceType: isVoice(p) ? 'voice' : 'track' };
  }

  function doAction(dispatch, actionId, data) {
    dispatch({ type: 'async:action/doAction', payload: { actionId, data: { ...data, actionPayload: data.actionPayload || {} }, parentData: {}, eventType: 'click' } });
  }

  function readSpeed(p) {
    const v = Number(isVoice(p) ? p.playingSpeed : p.playingSpeedTrack);
    return Number.isFinite(v) && v > 0 ? v : 1;
  }

  actions.menuInfo = async (msg, { getStore }) => {
    const s = getStore()?.getState() || {};
    const group = s.abtest?.['PH-MAC-playSpeed']?.expGroupName;
    return { speed: readSpeed(s.playing || {}), speedShown: group == null || group === 't1' };
  };

  actions.menuSpeed = async (msg, { dispatch, getStore }) => {
    const v = Number(msg.speed);
    if (!(v >= 0.25 && v <= 4)) throw new Error('bad speed');
    const { p } = current(getStore);
    dispatch({ type: 'playing/switchPlayingSpeed', payload: { playingSpeed: v, isTrack: !isVoice(p) } });
    await new Promise((r) => setTimeout(r, 50));
    return { speed: readSpeed(getStore()?.getState().playing || {}) };
  };

  actions.menuLink = async (msg, { dispatch }) => {
    const id = String(msg.id ?? '');
    if (!/^\d+$/.test(id) || id === '0') throw new Error('bad id');
    if (msg.kind === 'artist') doAction(dispatch, 'link', { resourceType: 'artist', resource: { id }, to: { state: window.history?.state?.state } });
    else if (msg.kind === 'album') doAction(dispatch, 'link', { resourceType: 'album', resource: { id }, to: {} });
    else throw new Error('bad kind');
    return true;
  };

  actions.menuRun = async (msg, { dispatch, getStore, nativeCall }) => {
    const what = String(msg.what || '');
    if (!RUN.has(what)) throw new Error('bad item');
    const { p, resource, resourceType } = current(getStore);
    if (!resource) throw new Error('nothing playing');
    // showWindow("show") activates the app as well; bringWindowToTop does not
    try {
      if (window.channel?.call) window.channel.call('winhelper.showWindow', () => {}, ['show']);
      else nativeCall?.('winhelper.showWindow', ['show']);
    } catch (e) { console.error('[BetterNCM] menuRun: showWindow failed', e); }
    await new Promise((r) => setTimeout(r, RAISE_MS));
    doAction(dispatch, what, { resource, resourceType, from: { scene: 'newMiniBar' }, actionPayload: { playingMode: p.playingMode } });
    return true;
  };
})();
