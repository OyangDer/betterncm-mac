// The lyrics window's 评论 panel, NCM side (LYRICS-WINDOW.md, ncmAction). The panel reads the
// comments itself with the plain GET (fetch); what needs NCM's session or its dialogs runs here,
// the way NCM's own vinyl comment tab does it (CommentArea.tsx, CommentCard.jsx, RichParagraph):
//   commentLike     like / unlike a comment (the hostResource model's effects)
//   commentLogin    NCM's login dialog
//   commentPublish  NCM's 发布评论 / 回复评论 dialog; resolves with the new comment when it is sent
//   commentShare    分享 to 云音乐笔记 or 私信 (NCM's dialogs)
//   commentLink     an NCM route: a user's page, an @mention, a #topic#, 查看更多精彩评论
//   commentOpenUrl  a link in a comment, in the browser
//   commentAssets   NCM's own images (emoji, the empty-state picture) as data URLs, which the
//                   window cannot load from orpheus://
// The dialogs open in NCM's window, so the panel collapses the lyrics window before asking.

function installLyricsCommentActions() {
  if (typeof __BNCM_CFG__ === 'undefined' || __BNCM_CFG__['mac.lyricsWindow'] !== 'true') return;
  if (!location.href.startsWith('orpheus://orpheus/app.html')) return;

  const actions = (window.__bncmLyricsActions ||= {});
  const str = (v) => (v == null ? '' : String(v));
  const ASSET_BASE = 'orpheus://orpheus/pub/public/';
  const ASSET_PATHS = /^assets\/img\/(common\/emt\/(2x\/)?emoji_\d+(_16|_20)?|empty\/cm_empty_wupinglun(@dark)?)\.(webp|png)$/;
  // one path segment after the route's prefix: no '/', so nothing can climb out of it
  const ROUTES = /^\/(userDetail\/user\/\d+|userDetail\/nickname\/[^/\s]+|community\/topic\/[^/\s]+|hotComments\/[\w-]+)$/;
  const MIME = { webp: 'image/webp', png: 'image/png' };

  // NCM's modal helper, found by what it exports (module ids change between builds) through the
  // bridge's webpack require.
  let modals = null;
  function modalHelper(require) {
    if (modals) return modals;
    const cache = require?.()?.c || {};
    for (const id of Object.keys(cache)) {
      // a getter of a module still evaluating may throw
      try {
        const d = cache[id]?.exports?.default;
        if (d && typeof d.CommentPublishModal === 'function') return (modals = d);
      } catch { /* next */ }
    }
    return null;
  }

  const isAnonymous = (store) => !!store?.getState().host?.isAnonymous;

  // NCM's normaliser (module 21) shape, which its share and reply code reads: string ids, user.id.
  function ncmUser(u) {
    if (!u) return undefined;
    const id = str(u.id || u.userId);
    return { ...u, id, userId: Number(id) || id, nickname: str(u.nickname) };
  }
  function ncmComment(c) {
    return { ...c, id: str(c.id || c.commentId), user: ncmUser(c.user) };
  }
  // ... and back to the API's shape, which the panel parses.
  function apiComment(c) {
    if (!c) return null;
    const user = c.user || {};
    return {
      commentId: str(c.id || c.commentId),
      parentCommentId: c.parentCommentId || 0,
      status: c.status || 0,
      content: c.content || '',
      richContent: c.richContent || null,
      time: c.time || Date.now(),
      timeStr: c.timeStr || '',
      likedCount: c.likedCount || 0,
      liked: !!c.liked,
      pendantData: c.pendantData || null,
      user: { userId: str(user.id || user.userId), nickname: str(user.nickname), avatarUrl: str(user.avatarUrl), vipRights: user.vipRights || null, avatarDetail: user.avatarDetail || null },
      beReplied: (c.beReplied || []).map((r) => ({
        beRepliedCommentId: r.beRepliedCommentId, content: r.content, richContent: r.richContent, status: r.status,
        user: r.user && { userId: str(r.user.id || r.user.userId), nickname: str(r.user.nickname) },
      })),
    };
  }

  actions.commentLike = async (m, { getStore, dispatch }) => {
    if (isAnonymous(getStore())) return { anonymous: true };
    const commentId = str(m.commentId);
    const threadId = str(m.threadId);
    if (!commentId || !threadId) throw new Error('no comment');
    // NCM's card treats the dispatch's return value as success and never learns the server's answer
    const res = dispatch({ type: m.like ? 'async:hostResource/likeComment' : 'async:hostResource/unlikeComment', payload: { commentId, threadId } });
    return { ok: !!res };
  };

  actions.commentLogin = async (m, { dispatch }) => {
    dispatch({ type: 'host/login', payload: {} });
    return true;
  };

  actions.commentPublish = async (m, { getStore, dispatch, require }) => {
    const threadId = str(m.threadId);
    const helper = modalHelper(require);
    if (!threadId || !helper) throw new Error('publish unavailable');
    const reply = m.reply && m.reply.id ? m.reply : null;
    const opts = reply
      ? { id: str(reply.id), threadId, user: ncmUser(reply.user), fromVinylPage: true }
      : { threadId, fromVinylPage: true, title: `歌曲：${str(m.title)}` };
    const res = await helper.CommentPublishModal(opts);
    const c = Array.isArray(res) ? res[0] : null;
    if (!c) return null;
    const n = Number(getStore()?.getState().playing?.commentNumber) || 0;
    dispatch({ type: 'playing/onUpdate', payload: { commentNumber: n + 1 } });
    return apiComment(c);
  };

  actions.commentShare = async (m, { dispatch }) => {
    const threadId = str(m.threadId);
    const platform = Number(m.platform) === 1 ? 1 : 0; // SHARE_PLATPORM_TYEP.events / .messages
    if (!threadId || !m.comment) throw new Error('no comment');
    dispatch({
      type: 'async:action/doAction',
      payload: {
        actionId: 'share',
        data: { resource: ncmComment(m.comment), resourceType: 'comment', to: { resourceIdOfScene: platform }, from: { resourceIdOfScene: threadId } },
        eventType: 'click',
      },
    });
    return true;
  };

  actions.commentLink = async (m, { dispatch, pushRoute }) => {
    const path = str(m.path);
    if (!ROUTES.test(path)) throw new Error('route not allowed');
    // a user's page by id goes through NCM's link action, as its menus open artists and users
    const user = /^\/userDetail\/user\/(\d+)$/.exec(path);
    if (user) {
      dispatch({ type: 'async:action/doAction', payload: { actionId: 'link', data: { resource: { id: user[1] }, resourceType: 'user' }, eventType: 'click' } });
      return true;
    }
    // NCM's own clicks history.push these paths (查看更多精彩评论 does, checked); its link action is
    // the fallback when the history is not found
    if (pushRoute(path)) return true;
    dispatch({
      type: 'async:action/doAction',
      payload: { actionId: 'link', data: { resource: {}, resourceType: 'unknown', to: { linkPath: path } }, eventType: 'click' },
    });
    return true;
  };

  actions.commentOpenUrl = async (m, { nativeCall }) => {
    const url = str(m.url);
    if (!/^https?:\/\//.test(url)) throw new Error('not a web link');
    nativeCall('os.navigateExternal', [url]);
    return true;
  };

  actions.commentAssets = async (m) => {
    const paths = (Array.isArray(m.paths) ? m.paths : []).map(str).filter((p) => ASSET_PATHS.test(p)).slice(0, 80);
    const out = {};
    await Promise.all(paths.map(async (p) => {
      try {
        const r = await fetch(ASSET_BASE + p);
        if (!r.ok) return;
        const bytes = new Uint8Array(await r.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        // orpheus:// answers .webp as application/octet-stream, so the type comes from the name
        out[p] = `data:${MIME[p.split('.').pop()]};base64,${btoa(bin)}`;
      } catch { /* left out: the panel shows the text instead */ }
    }));
    return out;
  };
}

installLyricsCommentActions();
