// The lyrics window's 百科 and 相似推荐 panels, NCM's side (LYRICS-WINDOW.md, ncmAction).
//
// wikiGet: the 音乐百科 data. NCM signs this request with a secret key that only its native side
// hands out; an unsigned request still answers 200, just with no rows. The key stays in this page:
// it is neither returned nor logged.
// wikiCtx: what the panels need from NCM's state (vinyl VIP for the 试听 tag, liked songs).
// wikiOpen / wikiPlay / wikiTrack: the clicks, dispatched exactly as NCM's
// own cards and track rows dispatch them (async:action/doAction), so NCM keeps its queue rules.
//
// Module ids are those of NCM 3.1.14 (build 18d435e); each use checks that the export is there
// and falls back to the raw objects otherwise.

(() => {
  const actions = (window.__bncmLyricsActions ||= {});

  // webpack's require comes from the bridge (helpers.require), which takes it only once webpack's
  // runtime is in place; each action hands it over before it needs a module.
  let getRequire = null;
  function req(id) {
    try { const r = getRequire?.(); return r ? r(id) : null; } catch { return null; }
  }
  const use = (helpers) => { if (typeof helpers?.require === 'function') getRequire = helpers.require; };

  // MD5 as NCM's module 108 h() computes it, for ASCII input (an id and a hex key).
  function md5(str) {
    str = unescape(encodeURIComponent(str));
    const add = (x, y) => { const l = (x & 0xffff) + (y & 0xffff); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff); };
    const rol = (n, c) => (n << c) | (n >>> (32 - c));
    const q = (f, b, x, s, t, a) => add(rol(add(add(a, f), add(x, t)), s), b);
    const F = (a, b, c, d, x, s, t) => q((b & c) | (~b & d), b, x, s, t, a);
    const G = (a, b, c, d, x, s, t) => q((b & d) | (c & ~d), b, x, s, t, a);
    const H = (a, b, c, d, x, s, t) => q(b ^ c ^ d, b, x, s, t, a);
    const I = (a, b, c, d, x, s, t) => q(c ^ (b | ~d), b, x, s, t, a);
    const n = str.length;
    const w = [];
    for (let i = 0; i < n; i++) w[i >> 2] |= str.charCodeAt(i) << ((i % 4) * 8);
    w[n >> 2] |= 0x80 << ((n % 4) * 8);
    w[(((n + 8) >> 6) << 4) + 14] = n * 8;
    const R = [
      [F, [7, 12, 17, 22], (j) => j, [-680876936, -389564586, 606105819, -1044525330, -176418897, 1200080426, -1473231341, -45705983, 1770035416, -1958414417, -42063, -1990404162, 1804603682, -40341101, -1502002290, 1236535329]],
      [G, [5, 9, 14, 20], (j) => (5 * j + 1) % 16, [-165796510, -1069501632, 643717713, -373897302, -701558691, 38016083, -660478335, -405537848, 568446438, -1019803690, -187363961, 1163531501, -1444681467, -51403784, 1735328473, -1926607734]],
      [H, [4, 11, 16, 23], (j) => (3 * j + 5) % 16, [-378558, -2022574463, 1839030562, -35309556, -1530992060, 1272893353, -155497632, -1094730640, 681279174, -358537222, -722521979, 76029189, -640364487, -421815835, 530742520, -995338651]],
      [I, [6, 10, 15, 21], (j) => (7 * j) % 16, [-198630844, 1126891415, -1416354905, -57434055, 1700485571, -1894986606, -1051523, -2054922799, 1873313359, -30611744, -1560198380, 1309151649, -145523070, -1120210379, 718787259, -343485551]],
    ];
    let A = 1732584193; let B = -271733879; let C = -1732584194; let D = 271733878;
    for (let i = 0; i < w.length; i += 16) {
      const o = [A, B, C, D];
      for (const [fn, sh, idx, T] of R) {
        for (let j = 0; j < 16; j++) {
          const r = fn(A, B, C, D, w[i + idx(j)] | 0, sh[j % 4], T[j]);
          A = D; D = C; C = B; B = r;
        }
      }
      A = add(A, o[0]); B = add(B, o[1]); C = add(C, o[2]); D = add(D, o[3]);
    }
    return [A, B, C, D].map((v) => { let s = ''; for (let j = 0; j < 4; j++) s += (`0${((v >> (j * 8)) & 255).toString(16)}`).slice(-2); return s; }).join('');
  }

  const songId = (v) => String(v ?? '').replace(/^(track|voice|mv)-/i, '');

  actions.wikiGet = async (msg, helpers) => {
    use(helpers);
    const id = songId(msg.songId);
    if (!/^\d+$/.test(id)) throw new Error('bad song id');
    const res = await req(4)?.App?.getCommonData?.({ type: 'secretKey' });
    const key = res?.data?.secretKey;
    if (!key) return null; // NCM shows no card without the key either
    const sign = md5(`songId=${id}&_scver=1&_sckey=${key}`);
    const r = await fetch(`https://music.163.com/api/music/wiki/home/song/desktop/get?songId=${id}&_scver=1&_sign=${sign}`, { credentials: 'include' });
    return r.json();
  };

  actions.wikiCtx = async (msg, { getStore }) => {
    const s = getStore()?.getState() || {};
    const likes = s['async:hostResource']?.likeTracksMap || {};
    const liked = {};
    for (const id of Array.isArray(msg.ids) ? msg.ids : []) liked[id] = likes[String(id)] === true;
    return { vinylVip: !!s.host?.isVinylVip, liked };
  };

  // Raw API objects -> the objects NCM keeps in its cards' state (module 21 formatters).
  async function formatSongs(list, getStore) {
    const F = req(21);
    if (!F?.D || !F.x) return list;
    try { return await F.D(list, F.x, { db: { uid: getStore()?.getState().host?.uid || '' } }); } catch { return list; }
  }
  async function formatPlaylist(pl) {
    const F = req(21);
    if (!F?.D || !F.v) return { ...pl, id: String(pl.id) };
    try { return (await F.D([pl], F.v))[0]; } catch { return { ...pl, id: String(pl.id) }; }
  }

  function doAction(dispatch, actionId, data, parentData = {}, eventType = 'click') {
    dispatch({ type: 'async:action/doAction', payload: { actionId, data: { ...data, actionPayload: data.actionPayload || {} }, parentData, eventType } });
  }

  actions.wikiOpen = async (msg, helpers) => {
    use(helpers);
    const { dispatch } = helpers;
    const id = String(msg.id ?? '');
    if (!/^\d+$/.test(id)) throw new Error('bad id');
    if (msg.kind === 'playlist') {
      const pl = await formatPlaylist(msg.resource || { id });
      doAction(dispatch, 'link', { resource: pl, resourceType: 'playlist', to: { linkPath: `/playlist/${id}` } });
    } else if (msg.kind === 'artist') {
      doAction(dispatch, 'link', { resourceType: 'artist', resource: { ...(msg.resource || {}), id }, to: { state: window.history?.state?.state } });
    } else if (msg.kind === 'album') {
      doAction(dispatch, 'link', { resourceType: 'album', resource: { ...(msg.resource || {}), id }, to: {} });
    } else if (msg.kind === 'mv') {
      doAction(dispatch, 'link', { resource: { id, type: 1 }, resourceType: 'mv', to: { linkPath: `/videoDetail/${id}`, state: { scene: 'unknown' } } });
    } else {
      throw new Error('bad kind');
    }
    return true;
  };

  // how: 'all' (the ▶ 播放 button), 'one' (a cover's play button), 'dbl' (a row double-clicked).
  actions.wikiPlay = async (msg, helpers) => {
    use(helpers);
    const { dispatch, getStore } = helpers;
    const raw = Array.isArray(msg.songs) ? msg.songs : [];
    const songs = await formatSongs(raw, getStore);
    const t = songs[Number(msg.index) || 0];
    if (msg.how === 'all') {
      doAction(dispatch, 'play', { resourceType: 'track', resource: {}, from: { listData: songs, text: '相似歌曲', scene: 'vinyl' } });
    } else if (msg.how === 'one' && t) {
      doAction(dispatch, 'play', { resource: t, resourceType: 'track', from: { text: '相似歌曲' } });
    } else if (msg.how === 'dbl' && t) {
      doAction(dispatch, 'play', { resource: t, resourceType: 'track', from: { scene: 'unknown' } },
        { resource: {}, resourceType: 'unknown', from: { isTableViewerAction: true, listData: songs, selectedData: undefined, text: '相似歌曲' } }, 'dbClick');
    } else {
      throw new Error('nothing to play');
    }
    return true;
  };

  // One track's hover tools in 相似歌曲. 收藏 and 更多 open NCM's own modal / menu, so the window
  // collapses for them (the page does that; for 更多 before this runs, so the menu stays open).
  actions.wikiTrack = async (msg, helpers) => {
    use(helpers);
    const { dispatch, getStore } = helpers;
    const [t] = await formatSongs([msg.song], getStore);
    if (!t) throw new Error('no song');
    if (msg.op === 'like') {
      dispatch({ type: 'async:hostResource/setLikeTrack', payload: { isLike: !!msg.like, resource: t, resourceType: 'track', from: 'vinyl' } });
    } else if (msg.op === 'favorite' || msg.op === 'download') {
      doAction(dispatch, msg.op, { resource: t, resourceType: 'track' });
    } else if (msg.op === 'menu') {
      const x = Number(msg.x) || innerWidth / 2;
      const y = Number(msg.y) || innerHeight / 2;
      const rawEvent = new MouseEvent('contextmenu', { clientX: x, clientY: y, screenX: window.screenX + x, screenY: window.screenY + y });
      doAction(dispatch, 'menu', { resource: t, resourceType: 'track', from: { scene: 'unknown' }, actionPayload: { rawEvent } });
    } else {
      throw new Error('bad op');
    }
    return true;
  };
})();
