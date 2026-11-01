// src/prelude/lyrics-bridge.js in a vm context with a fake NCM page: its redux store, webpack
// modules (the vinyl-page subject), native events through the channel shim's tap, and a clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = fs.readFileSync(path.join(ROOT, 'src/prelude/lyrics-bridge.js'), 'utf8');

class Element {
  constructor(tag = 'div', { matches = [], rect = { left: 0, top: 0, width: 10, height: 10 } } = {}) {
    this.tagName = tag;
    this.attrs = {};
    this.events = [];
    this.matches = matches; // selectors closest() answers with this element
    this.rect = rect;
    this.children = [];
  }
  closest(sel) { return this.matches.some((m) => sel.includes(m)) ? this : null; }
  getBoundingClientRect() { return this.rect; }
  dispatchEvent(e) { this.events.push(e.type); return true; }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
}

class Svg extends Element {
  constructor() { super('svg'); this.attrs = { width: '24', height: '24' }; this.removed = []; }
  cloneNode() { const c = new Svg(); c.attrs = { ...this.attrs }; return c; }
  querySelectorAll(sel) { return sel === 'defs' ? [{ remove: () => this.removed.push('defs') }] : []; }
  get outerHTML() { return `<svg${Object.entries(this.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}><path d="M0"/></svg>`; }
}

class Subject {
  constructor(v) { this.value = v; this.seen = []; this.subs = []; }
  next(v) { this.value = v; this.seen.push(v); this.subs.forEach((f) => f(v)); }
  getValue() { return this.value; }
  subscribe(f) { this.subs.push(f); f(this.value); return { unsubscribe() {} }; }
}

// values from the vm's realm, comparable with deepStrictEqual
const plain = (v) => JSON.parse(JSON.stringify(v));

const TRACK = {
  resourceTrackId: '1810227452', onlineResourceId: '1810227452', playId: '1810227452',
  resourceName: 'how to be alone', resourceArtists: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
  curTrack: { name: 'how to be alone', album: { id: 9, name: 'Album', picUrl: 'http://p3/x.jpg' }, transNames: ['如何独处'], duration: 218588 },
  resourceDuration: 218, resourceCoverUrl: 'http://p3/c.jpg', resourcePlayingQuality: 320, trackFileType: 'online',
  resourceCommentThreadId: 'R_SO_4_1810227452',
  playingState: 1, playingMode: 'playCycle', playingVolume: 0.6, isCanHeartBeat: true,
};

/**
 * webpack: false = no webpack runtime (the store-watching fallback).
 */
function load({ webpack = true, tap = true, state: initial = {}, cfg = 'true', href = 'orpheus://orpheus/app.html#/', early = false } = {}) {
  const posts = [];
  const actions = [];
  const nativeCalls = [];
  const fetches = [];
  const consoleOut = [];
  let now = 1000;
  let timers = [];
  let timerId = 0;
  const addTimer = (fn, ms, every) => { const id = ++timerId; timers.push({ id, at: now + Math.max(0, ms || 0), fn, every }); return id; };
  const clearTimer = (id) => { timers = timers.filter((t) => t.id !== id); };
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = timers[0];
      if (!t || t.at > end) break;
      now = t.at;
      if (t.every) t.at = now + t.every; else timers.shift();
      t.fn();
    }
    now = end;
  }

  // the store
  let state = {
    playing: { ...TRACK },
    'async:hostResource': { likeTracksMap: { 1810227452: true } },
    app: { isFullScreen: 0 },
    'page:vinylPage': { pageState: 'closed' },
    abtest: {},
    fmPlaying: {},
    ...initial,
  };
  const subs = [];
  const store = {
    getState: () => state,
    dispatch: (a) => { actions.push(plain(a)); return a; },
    subscribe: (f) => { subs.push(f); return () => {}; },
  };
  const setState = (patch) => { state = { ...state, ...patch }; subs.forEach((f) => f()); };
  const setPlaying = (patch) => setState({ playing: { ...state.playing, ...patch } });

  // webpack modules
  const vinyl = new Subject('closed');
  const history = { pushed: [], push(p) { this.pushed.push(p); } };
  const playlistModule = { opened: 0, openPlaylist() { this.opened++; } };
  const appHolder = { getStore: () => state, getDispatch: () => store.dispatch, getHistory: () => history, app: { _store: store } };
  const cache = {
    1: { exports: { a: { opening: 'opening', opened: 'opened', closing: 'closing', closed: 'closed' }, d: vinyl, c: new Subject(false) } },
    2: { exports: { a: appHolder } },
    3: { exports: { b: { minWidth: 1056, minHeight: 752, leftSideMinWidth: 204 } } },
    4: { exports: { get boom() { throw new ReferenceError('TDZ'); }, trap: new Proxy({}, { get() { throw new Error('trap'); } }) } },
    5: { exports: { default: playlistModule } },
  };
  const req = (id) => cache[id].exports;
  req.c = cache;

  // the page
  const bodyClasses = new Set();
  const listeners = {};
  const cover = new Element('div', { matches: ['.miniVinylWrapper'] });
  const dislikeSvg = new Svg();
  const dislikeBtn = new Element('button');
  const playlistBtn = new Element('button');
  const collapseBtn = new Element('button');
  const container = new Element('div');
  container.querySelector = () => collapseBtn;
  const dom = { dislike: false };
  const head = { children: [], appendChild(c) { this.children.push(c); } };
  // the fiber walk from the play bar finds the store when NCM's modules cannot be found
  const footer = { '__reactInternalInstance$abc': { memoizedProps: {}, return: { memoizedProps: { store } } } };
  const document = {
    body: { classList: { add: (c) => bodyClasses.add(c), remove: (c) => bodyClasses.delete(c), contains: (c) => bodyClasses.has(c), toggle: (c, on) => (on ? bodyClasses.add(c) : bodyClasses.delete(c)) } },
    // early: as NCM runs a prelude, before the document has any element
    head: early ? null : head,
    documentElement: early ? null : head,
    createElement: (tag) => new Element(tag),
    getElementById: () => null,
    addEventListener: (t, fn, capture) => (listeners[t] ||= []).push({ fn, capture }),
    querySelector: (sel) => {
      if (sel.includes('tid_fmdislike_btn') && sel.endsWith('svg')) return dom.dislike ? dislikeSvg : null;
      if (sel.includes('tid_fmdislike_btn')) return dom.dislike ? dislikeBtn : null;
      if (sel.includes('tid_playbar_playlist_btn')) return playlistBtn;
      if (sel === '#vinyl-page-container') return container;
      if (sel === 'footer') return footer;
      return null;
    },
    querySelectorAll: () => [],
  };
  const taps = [];
  const registered = [];
  const ctx = {
    __BNCM_CFG__: { 'mac.lyricsWindow': cfg },
    location: { href },
    document,
    Element,
    PointerEvent: class { constructor(type, o) { this.type = type; Object.assign(this, o); } },
    MouseEvent: class { constructor(type, o) { this.type = type; Object.assign(this, o); } },
    performance: { now: () => now },
    Date: { now: () => 1_700_000_000_000 + now },
    setTimeout: (fn, ms) => addTimer(fn, ms),
    setInterval: (fn, ms) => addTimer(fn, ms, ms),
    clearTimeout: clearTimer,
    clearInterval: clearTimer,
    console: { warn: (...a) => consoleOut.push(a.join(' ')), error: (...a) => consoleOut.push(a.join(' ')), log: () => {} },
    screen: { width: 1470, height: 956 },
    screenX: 0, screenY: 76, outerWidth: 1470, outerHeight: 752,
    channel: { call: (cmd, cb, params) => nativeCalls.push(plain([cmd, params])), registerCall: (cmd, fn) => registered.push([cmd, fn]) },
    localStorage: { length: 2, key: (i) => ['refined-now-playing-a', 'other'][i], getItem: () => '1' },
    fetch: async (url, opt) => { fetches.push([url, opt]); return { text: async () => '{"code":200}' }; },
    __bncmLyricsPost: (s) => posts.push(JSON.parse(s)),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  };
  if (tap) ctx.__bncmChannelTap = (fn) => taps.push(fn);
  ctx.window = ctx;
  vm.createContext(ctx);
  // webpack's runtime replaces the array's push; before it has, push is the plain one
  ctx.webpackJsonp = vm.runInContext('[]', ctx);
  if (webpack) ctx.webpackJsonp.push = (entry) => { const [, mods, run] = entry; for (const [k] of run) mods[k]({}, {}, req); };
  vm.runInContext(CODE, ctx);
  const domReady = () => { document.head = head; document.documentElement = head; (listeners.DOMContentLoaded || []).forEach((l) => l.fn()); };

  const emit = (cmd, args) => taps.forEach((f) => f(cmd, args));
  const progress = (pos, id = '1810227452') => emit('audioplayer.onPlayProgress', [id, pos.toFixed(2), '1.0000']);
  const cmd = (m) => ctx.__bncmLyricsBridge.cmd(m);
  const click = (target, init = {}) => {
    const e = { target, shiftKey: false, stopped: false, prevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; }, ...init };
    for (const l of listeners.click || []) if (l.capture) l.fn(e);
    return e;
  };
  const boot = () => advance(300 * 21);
  const ofType = (t) => posts.filter((p) => p.t === t);
  return { ctx, posts, ofType, actions, nativeCalls, fetches, consoleOut, advance, boot, setState, setPlaying, store, vinyl, history,
    playlistModule, registered, cover, dom, dislikeBtn, playlistBtn, collapseBtn, bodyClasses, head, domReady, emit, progress, cmd, click, taps,
    get state() { return state; }, get now() { return now; } };
}

test('loads before the document has elements, as NCM runs preludes, and still boots', () => {
  const b = load({ early: true });
  assert.equal(b.consoleOut.length, 0, b.consoleOut.join('\n'));
  assert.equal(b.head.children.length, 0, 'no style yet');
  b.domReady();
  assert.equal(b.head.children.length, 1, 'the stock-page style is added at DOMContentLoaded');
  b.boot();
  assert.equal(b.ctx.__bncmLyricsBridge.hooked, true);
  assert.equal(b.ofType('hello').length, 1);
});

test('does nothing unless the lyrics window is configured, in NCM\'s main page', () => {
  assert.equal(load({ cfg: 'false' }).ctx.__bncmLyricsBridge, undefined);
  assert.equal(load({ href: 'orpheus://orpheus/pub/app.html#/mini' }).ctx.__bncmLyricsBridge, undefined);
});

test('boot finds the store and the vinyl subject, then says hello', () => {
  const p = load();
  assert.deepEqual(p.posts, []);
  p.advance(300);
  assert.deepEqual(p.posts, [{ t: 'hello' }]);
  assert.equal(p.ctx.__bncmLyricsBridge.hooked, true);
  assert.equal(p.head.children[0].id, 'bncm-lyrics-bridge');
  // asking again (the relay does after attaching)
  assert.equal(p.cmd({ c: 'hello' }), true);
  assert.deepEqual(p.posts.at(-1), { t: 'hello' });
});

test('nothing is posted while the window is closed, except the request to open it', () => {
  const p = load();
  p.boot();
  p.posts.length = 0;
  for (let i = 0; i < 100; i++) { p.progress(10 + i / 30); p.advance(33); }
  p.emit('audioplayer.onPlayState', ['1810227452', '1810227452|pause', 2]);
  p.emit('audioplayer.onLoad', ['1810227452', {}]);
  p.setPlaying({ resourceTrackId: '2', resourceName: 'next' });
  p.setState({ 'async:hostResource': { likeTracksMap: {} } });
  p.advance(5000);
  assert.deepEqual(p.posts, []);
  assert.equal(p.consoleOut.length, 0);
  // no timer keeps running
  p.advance(60_000);
  assert.deepEqual(p.posts, []);
});

test('NCM opening its page by any way opens the window instead', () => {
  const p = load();
  p.boot();
  p.posts.length = 0;
  p.vinyl.next('opening');
  assert.deepEqual(p.posts, [{ t: 'open', frame: { x: 0, y: 76, w: 1470, h: 752 }, fullscreen: false }]);
  assert.equal(p.vinyl.value, 'closed', 'NCM\'s page never starts to open');
  assert.deepEqual(p.vinyl.seen, []);
  // a second request right after is the same one
  p.vinyl.next('opening');
  assert.equal(p.ofType('open').length, 1);
  p.advance(1000);
  p.setState({ app: { isFullScreen: 1 } });
  p.vinyl.next('opening');
  assert.equal(p.ofType('open')[1].fullscreen, true);
  // other values pass through
  p.vinyl.next('closing');
  assert.deepEqual(p.vinyl.seen, ['closing']);
});

test('a plain click on the play bar\'s cover is left to NCM\'s handler, which runs into the hook', () => {
  const p = load();
  p.boot();
  const e = p.click(p.cover);
  assert.equal(e.stopped, false);
  assert.equal(p.ofType('open').length, 0);
});

test('shift-click on the cover opens NCM\'s own page', () => {
  const p = load();
  p.boot();
  p.posts.length = 0;
  const e = p.click(p.cover, { shiftKey: true });
  assert.equal(e.stopped, false);
  assert.ok(p.bodyClasses.has('bncm-stock-vinyl'));
  p.vinyl.next('opening'); // NCM's cover handler
  p.vinyl.next('opened');
  assert.deepEqual(p.vinyl.seen, ['opening', 'opened']);
  assert.deepEqual(p.posts, []);
  p.advance(2000);
  assert.ok(p.bodyClasses.has('bncm-stock-vinyl'), 'kept while NCM\'s page is open');
  p.vinyl.next('closing');
  p.vinyl.next('closed');
  assert.ok(!p.bodyClasses.has('bncm-stock-vinyl'));
  p.vinyl.next('opening');
  assert.equal(p.ofType('open').length, 1, 'the next open is the window again');
});

test('a shift-click that opened nothing stops letting NCM\'s page through', () => {
  const p = load();
  p.boot();
  p.click(p.cover, { shiftKey: true });
  p.advance(2000);
  assert.ok(!p.bodyClasses.has('bncm-stock-vinyl'));
});

test('panels and the fallback let NCM\'s page open', () => {
  const p = load();
  p.boot();
  p.bodyClasses.add('bncm-rnp-panel');
  p.vinyl.next('opening');
  assert.deepEqual(p.vinyl.seen, ['opening']);
  p.bodyClasses.delete('bncm-rnp-panel');

  const q = load();
  q.boot();
  q.cmd({ c: 'fallback' });
  assert.deepEqual(q.actions, [{ type: 'playing/openVinylPage' }]);
  q.vinyl.next('opening'); // what openVinylPage does
  assert.deepEqual(q.vinyl.seen, ['opening']);
  assert.equal(q.ofType('open').length, 0);
  // closed and opened again: NCM's page is still let through, and still visible
  q.vinyl.next('closed');
  assert.ok(q.bodyClasses.has('bncm-stock-vinyl'));
  q.vinyl.next('opening');
  assert.deepEqual(q.vinyl.seen, ['opening', 'closed', 'opening']);
  assert.equal(q.ofType('open').length, 0);
});

test('without NCM\'s modules: the cover click is caught, and an opening page is collapsed', () => {
  const p = load({ webpack: false, state: {} });
  p.boot();
  assert.equal(p.ctx.__bncmLyricsBridge.hooked, false);
  assert.ok(p.consoleOut.some((l) => /subject not found/.test(l)));
  assert.deepEqual(p.ofType('hello').length, 1);
  const e = p.click(p.cover);
  assert.equal(e.stopped, true);
  assert.equal(e.prevented, true);
  assert.equal(p.ofType('open').length, 1);
  p.cmd({ c: 'active', v: true }); // the relay's answer
  p.cmd({ c: 'active', v: false });

  p.advance(1000);
  p.setState({ 'page:vinylPage': { pageState: 'opening' } });
  assert.equal(p.ofType('open').length, 2);
  p.cmd({ c: 'active', v: true });
  p.cmd({ c: 'active', v: false });
  p.setState({ 'page:vinylPage': { pageState: 'opened' } });
  p.advance(100);
  assert.deepEqual(p.collapseBtn.events, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  p.setState({ 'page:vinylPage': { pageState: 'closed' } });
  p.advance(5000);
  assert.equal(p.collapseBtn.events.length, 5, 'stops once closed');

  // shift-click lets NCM's page open in this path too
  const s = p.click(p.cover, { shiftKey: true });
  assert.equal(s.stopped, false);
  p.setState({ 'page:vinylPage': { pageState: 'opening' } });
  assert.equal(p.ofType('open').length, 2);
});

test('activating sends a snapshot and progress; progress goes at 4 Hz with jumps at once', () => {
  const p = load();
  p.boot();
  p.dom.dislike = false;
  p.progress(20);
  p.advance(10);
  p.posts.length = 0;
  p.cmd({ c: 'active', v: true });
  assert.ok(p.bodyClasses.has('bncm-lyrics-open'));
  const [snap, first] = p.posts;
  assert.equal(snap.t, 'snapshot');
  assert.deepEqual(snap.track, {
    id: '1810227452', playId: '1810227452', title: 'how to be alone', alias: '', trans: '如何独处',
    artists: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }], album: { id: '9', name: 'Album' }, duration: 218,
    cover: 'http://p3/c.jpg', quality: '320', qualityName: 'exhigh', envSound: '', fileType: 'online',
    threadId: 'R_SO_4_1810227452', local: false,
  });
  assert.equal(snap.playing, false);
  assert.equal(snap.liked, true);
  assert.equal(snap.mode, 'repeat');
  assert.equal(snap.volume, 0.6);
  assert.equal(snap.roaming, false);
  assert.deepEqual(snap.frame, { x: 0, y: 76, w: 1470, h: 752 });
  assert.equal(first.t, 'progress');
  assert.equal(first.pos, 20, 'paused: no time added');
  assert.equal(first.force, true);

  p.posts.length = 0;
  p.emit('audioplayer.onPlayState', ['1810227452', '1810227452|resume', 1]);
  assert.deepEqual(p.posts, [{ t: 'state', playing: true }]);
  p.posts.length = 0;
  let pos = 20;
  for (let i = 0; i < 60; i++) { p.advance(33); pos += 0.033; p.progress(pos); } // ~2 s at 30 Hz
  const prog = p.ofType('progress');
  assert.ok(prog.length >= 7 && prog.length <= 9, `about 4 a second, got ${prog.length}`);
  assert.ok(prog.every((m) => !m.force));
  assert.ok(prog.every((m) => m.wall === 1_700_000_000_000 + 0 || m.wall > 1_700_000_000_000));

  // jumps: back, forward beyond the elapsed time, another track
  for (const [to, id] of [[5, undefined], [120, undefined], [0, '99']]) {
    p.posts.length = 0;
    p.advance(33);
    p.progress(to, id);
    assert.equal(p.posts.length, 1);
    assert.equal(p.posts[0].force, true);
    assert.equal(p.posts[0].pos, to);
  }

  // inactive again: quiet
  p.cmd({ c: 'active', v: false });
  assert.ok(!p.bodyClasses.has('bncm-lyrics-open'));
  p.posts.length = 0;
  p.progress(1);
  p.advance(1000);
  assert.deepEqual(p.posts, []);
});

test('advancing progress counts as playing when no play-state event has come', () => {
  const p = load();
  p.boot();
  p.cmd({ c: 'active', v: true });
  p.posts.length = 0;
  p.progress(10);
  p.advance(33);
  p.progress(10.03);
  assert.deepEqual(p.ofType('state'), [{ t: 'state', playing: true }]);
});

test('store changes send track, liked, mode, volume and roaming while active', () => {
  const p = load();
  p.boot();
  p.cmd({ c: 'active', v: true });
  p.posts.length = 0;

  p.setPlaying({ resourceTrackId: '2', onlineResourceId: '2', resourceName: 'Two', resourcePlayingQuality: 2999, resourceDuration: 0, curTrack: { name: 'Two', duration: 90000 } });
  p.advance(50);
  const [tr] = p.ofType('track');
  assert.equal(tr.id, '2');
  assert.equal(tr.title, 'Two');
  assert.equal(tr.duration, 90);
  assert.equal(tr.envSound, 'dolby', 'side.js shows Dolby Atmos');
  assert.equal(tr.qualityName, 'dolby');
  assert.deepEqual(p.ofType('liked'), [{ t: 'liked', v: false }]);

  p.posts.length = 0;
  p.setState({ 'async:hostResource': { likeTracksMap: { 2: true } } });
  p.advance(50);
  assert.deepEqual(p.posts, [{ t: 'liked', v: true }]);

  p.posts.length = 0;
  p.setPlaying({ playingMode: 'playOneCycle' });
  p.setPlaying({ playingVolume: 0.25 });
  p.advance(50);
  assert.deepEqual(p.posts, [{ t: 'mode', v: 'one' }, { t: 'volume', v: 0.25 }], 'several changes, one check');

  // an unrelated slice changes: nothing read, nothing sent
  p.posts.length = 0;
  p.setState({ other: 1 });
  p.advance(50);
  assert.deepEqual(p.posts, []);

  // roaming: the dislike icon comes with it once NCM has rendered its button
  p.setPlaying({ playingMode: 'playFm', lastPlayingMode: 'playRandom' });
  p.advance(50);
  assert.deepEqual(p.ofType('roaming'), [{ t: 'roaming', v: true }]);
  assert.deepEqual(p.ofType('mode'), [{ t: 'mode', v: 'random' }]);
  p.dom.dislike = true;
  p.advance(500);
  const withIcon = p.ofType('roaming')[1];
  assert.equal(withIcon.v, true);
  assert.equal(withIcon.icon, '<svg><path d="M0"/></svg>', 'no fixed size');
  p.posts.length = 0;
  p.setPlaying({ playingMode: 'playCycle' });
  p.advance(50);
  assert.deepEqual(p.ofType('roaming'), [{ t: 'roaming', v: false }]);
  // the snapshot carries the icon from now on
  p.cmd({ c: 'snapshot' });
  assert.equal(p.posts.at(-1).dislikeIcon, '<svg><path d="M0"/></svg>');
});

test('commands dispatch NCM\'s own effects', () => {
  const p = load();
  p.boot();
  const run = (m) => { p.actions.length = 0; const r = p.cmd(m); return [r, p.actions.slice()]; };
  assert.deepEqual(run({ c: 'toggle' })[1], [{ type: 'playing/switchResumeOrPause', payload: { triggerScene: 'miniBar' } }]);
  assert.deepEqual(run({ c: 'prev' })[1], [{ type: 'playingList/jump2Track', payload: { flag: -1, type: 'call', triggerScene: 'miniBar' } }]);
  assert.deepEqual(run({ c: 'next' })[1], [{ type: 'playingList/jump2Track', payload: { flag: 1, type: 'call', triggerScene: 'miniBar' } }]);
  assert.deepEqual(run({ c: 'seek', sec: 42.5 })[1], [{ type: 'playing/setPlayingPosition', payload: { duration: 42.5 } }]);
  assert.deepEqual(run({ c: 'seek', sec: 'x' }), [false, []]);
  assert.deepEqual(run({ c: 'volume', v: 1.4 })[1], [{ type: 'playing/setVolume', payload: { volume: 1 } }]);
  assert.deepEqual(run({ c: 'like' })[1], [{ type: 'async:hostResource/setLikeCurPlayingTrack', payload: { from: 'miniBar' } }]);

  // mode: NCM's cycle, with heart mode when allowed
  const mode = (playingMode, extra = {}, top = {}) => {
    p.setPlaying({ playingMode, ...extra });
    p.setState(top);
    return run({ c: 'mode' })[1][0]?.payload?.playingMode;
  };
  assert.equal(mode('playCycle'), 'playOneCycle');
  assert.equal(mode('playOrder'), 'playAi');
  assert.equal(mode('playAi'), 'playCycle');
  assert.equal(mode('playOrder', { isCanHeartBeat: false }), 'playCycle');
  assert.equal(mode('playRandom', { isCanHeartBeat: false }), 'playOrder');
  assert.equal(mode('playRandom', {}, { 'async:listenTogether': { status: 'together', roomInfo: { roomId: 'r' } } }), 'playCycle');
  p.setState({ 'async:listenTogether': undefined });
  p.setPlaying({ playingMode: 'playCycle', isCanHeartBeat: true });
  assert.deepEqual(run({ c: 'mode' })[1], [{ type: 'playing/switchPlayingMode', payload: { playingMode: 'playOneCycle', triggerScene: 'miniBar', HeartBeatFlage: true } }]);
  // roaming: disabled, except NCM's single/endless FM switch
  p.setPlaying({ playingMode: 'playFm' });
  assert.deepEqual(run({ c: 'mode' }), [false, []]);
  p.setState({ abtest: { 'PH-PC-FM-Single': { expGroupName: 't1' } } });
  assert.deepEqual(run({ c: 'mode' }), [true, [{ type: 'fmPlaying/switchPlayingMode', payload: {} }]]);

  // playlist: NCM's own opener, else its button
  assert.equal(p.cmd({ c: 'playlist' }), true);
  assert.equal(p.playlistModule.opened, 1);

  // dislike: NCM's blacklist modal for the FM track, else NCM's button
  // the scene's FM state as NCM's selector picks it: privateFm, privateFmByMode[mode], zoneFm[id]
  const fmTrack = { id: 5, alg: 'x' };
  const stale = { id: 6 };
  p.setState({ fmPlaying: { currentScene: 'fm', privateFm: { current: fmTrack }, privateFmByMode: { x: { current: stale } } } });
  p.setState({ abtest: { 'PH-PC-Blacklist': { expGroupName: 't1' } } });
  assert.deepEqual(run({ c: 'dislike' })[1], [{ type: 'playing/openDislikeModal', payload: { resource: fmTrack, resourceType: 'track', scene: 'fm' } }]);
  p.setState({ fmPlaying: { currentScene: 'fm', currentMode: 'SCENE_RCMD', privateFm: { current: stale }, privateFmByMode: { SCENE_RCMD: { fmTracks: [stale, fmTrack], currentIndex: 1 } } } });
  assert.deepEqual(run({ c: 'dislike' })[1][0].payload.resource, fmTrack);
  p.setState({ fmPlaying: { currentScene: 'zoneFm', currentId: 7, privateFm: { current: stale }, zoneFm: { 7: { current: fmTrack } } } });
  assert.deepEqual(run({ c: 'dislike' })[1], [{ type: 'playing/openDislikeModal', payload: { resource: fmTrack, resourceType: 'track', scene: 'zoneFm' } }]);
  p.setState({ abtest: {} });
  p.dom.dislike = true;
  assert.deepEqual(run({ c: 'dislike' }), [true, []]);
  assert.ok(p.dislikeBtn.events.includes('click'));
  p.setPlaying({ playingMode: 'playCycle' });
  assert.deepEqual(run({ c: 'dislike' }), [false, []], 'only while roaming');

  // nav: NCM 2 hashes through NCM 3's link action
  assert.deepEqual(run({ c: 'nav', hash: '#/m/artist/?id=12' })[1], [{ type: 'async:action/doAction', payload: { actionId: 'link', data: { resource: { id: '12' }, resourceType: 'artist' } } }]);
  assert.equal(run({ c: 'nav', hash: '#/m/album/?id=34' })[1][0].payload.data.resourceType, 'album');
  assert.equal(run({ c: 'nav', hash: '#/m/personal/?uid=56' })[1][0].payload.data.resourceType, 'user');
  assert.equal(p.cmd({ c: 'nav', hash: '#/m/song/?id=78' }), true);
  assert.deepEqual(p.history.pushed, ['/comment/R_SO_4_78']);
  // nothing else: no NCM 3 path, however harmless it looks
  for (const hash of ['#/album/90', '/comment/R_SO_4_1', '#/m/song/?id=78&x=/y', '#/m/song/?id=78/../../x', 'https://evil.example/', '#//evil.example/', '']) {
    assert.equal(p.cmd({ c: 'nav', hash }), false, hash);
  }
  assert.deepEqual(p.history.pushed, ['/comment/R_SO_4_78']);

  // unknown commands and prototype names
  assert.equal(p.cmd({ c: 'toString' }), false);
  assert.equal(p.cmd({ c: 'nope' }), false);
  assert.equal(p.cmd(null), false);
});

test('showNcm moves NCM only when the frame differs, and puts its minimum size back', () => {
  const p = load();
  p.boot();
  p.cmd({ c: 'showNcm', frame: { x: 0, y: 76, w: 1470, h: 752 }, cocoa: { x: 0, y: 128, w: 1470, h: 752 } });
  assert.deepEqual(p.nativeCalls, [['winhelper.bringWindowToTop', []]]);
  p.nativeCalls.length = 0;
  p.cmd({ c: 'showNcm', frame: { x: 100, y: 76, w: 1200, h: 800 }, cocoa: { x: 100, y: 80, w: 1200, h: 800 } });
  assert.deepEqual(p.nativeCalls, [
    ['winhelper.setWindowPosition', [{ x: 100, y: 80, width: 1200, height: 800, topmost: false }]],
    ['winhelper.setWindowSizeLimit', [{ x: 1056, y: 752 }, { x: 0, y: 0 }]],
    ['winhelper.bringWindowToTop', []],
  ]);
  p.nativeCalls.length = 0;
  p.cmd({ c: 'minimizeNcm' });
  assert.deepEqual(p.nativeCalls, [['winhelper.showWindow', ['minimize']]], 'no frame: minimized where it is');
});

test('minimizeNcm moves NCM to the window\'s frame first, without raising it', () => {
  const p = load();
  p.boot();
  p.cmd({ c: 'minimizeNcm', frame: { x: 100, y: 76, w: 1200, h: 800 }, cocoa: { x: 100, y: 80, w: 1200, h: 800 } });
  assert.deepEqual(p.nativeCalls, [
    ['winhelper.setWindowPosition', [{ x: 100, y: 80, width: 1200, height: 800, topmost: false }]],
    ['winhelper.setWindowSizeLimit', [{ x: 1056, y: 752 }, { x: 0, y: 0 }]],
    ['winhelper.showWindow', ['minimize']],
  ]);
  p.nativeCalls.length = 0;
  p.cmd({ c: 'minimizeNcm', frame: { x: 0, y: 76, w: 1470, h: 752 }, cocoa: { x: 0, y: 128, w: 1470, h: 752 } });
  assert.deepEqual(p.nativeCalls, [['winhelper.showWindow', ['minimize']]], 'already there');
});

test('NCM\'s window is hidden during full screen and comes back on unhide, collapse or detach', () => {
  const p = load();
  p.boot();
  const frame = { x: 100, y: 76, w: 1200, h: 800 };
  const cocoa = { x: 100, y: 80, w: 1200, h: 800 };
  assert.equal(p.cmd({ c: 'unhideNcm', frame, cocoa }), false, 'not hidden: nothing to do');
  assert.deepEqual(p.nativeCalls, []);
  p.cmd({ c: 'hideNcm' });
  assert.deepEqual(p.nativeCalls, [['winhelper.showWindow', ['hide']]]);
  p.nativeCalls.length = 0;
  p.cmd({ c: 'unhideNcm', frame, cocoa });
  assert.deepEqual(p.nativeCalls, [
    ['winhelper.setWindowPosition', [{ x: 100, y: 80, width: 1200, height: 800, topmost: false }]],
    ['winhelper.setWindowSizeLimit', [{ x: 1056, y: 752 }, { x: 0, y: 0 }]],
    ['winhelper.showWindow', ['show']],
  ]);
  p.nativeCalls.length = 0;
  p.cmd({ c: 'unhideNcm', frame, cocoa });
  assert.deepEqual(p.nativeCalls, [], 'shown once');
  // collapsing while hidden shows it before raising it
  p.cmd({ c: 'hideNcm' });
  p.nativeCalls.length = 0;
  p.cmd({ c: 'showNcm' });
  assert.deepEqual(p.nativeCalls, [['winhelper.showWindow', ['show']], ['winhelper.bringWindowToTop', []]]);
  // the injector going away while hidden
  p.cmd({ c: 'hideNcm' });
  p.nativeCalls.length = 0;
  p.cmd({ c: 'detach' });
  assert.deepEqual(p.nativeCalls, [['winhelper.showWindow', ['show']]]);
});

test('fetch goes to NCM\'s API hosts only', async () => {
  const p = load();
  p.boot();
  p.posts.length = 0;
  await p.cmd({ c: 'fetch', rid: 1, url: 'https://music.163.com/api/song/lyric?id=1' });
  await p.cmd({ c: 'fetch', rid: 2, url: 'https://interface3.music.163.com/api/x' });
  await p.cmd({ c: 'fetch', rid: 3, url: 'https://evil.example/api' });
  await p.cmd({ c: 'fetch', rid: 4, url: 'https://music.163.com.evil.example/' });
  await p.cmd({ c: 'fetch', rid: 5, url: 'http://music.163.com/api/x' });
  assert.deepEqual(p.fetches.map(([u, o]) => [u, o.credentials]), [
    ['https://music.163.com/api/song/lyric?id=1', 'include'],
    ['https://interface3.music.163.com/api/x', 'include'],
  ]);
  assert.deepEqual(p.posts, [
    { t: 'reply', rid: 1, ok: true, data: { code: 200 } },
    { t: 'reply', rid: 2, ok: true, data: { code: 200 } },
    { t: 'reply', rid: 3, ok: false, error: 'host not allowed' },
    { t: 'reply', rid: 4, ok: false, error: 'host not allowed' },
    { t: 'reply', rid: 5, ok: false, error: 'host not allowed' },
  ]);
});

test('ncmAction runs registered actions with the helpers, rnpSettings reads RNPN\'s keys', async () => {
  const p = load();
  p.boot();
  p.posts.length = 0;
  p.ctx.__bncmLyricsActions.echo = async (m, h) => ({ got: m.x, id: h.trackId(), hasReq: typeof h.require === 'function', push: h.pushRoute('/hotComments/1') });
  p.ctx.__bncmLyricsActions.fail = () => { throw new Error('nope'); };
  assert.equal(await p.cmd({ c: 'ncmAction', rid: 1, action: 'echo', x: 3 }), true);
  assert.equal(await p.cmd({ c: 'ncmAction', rid: 2, action: 'fail' }), false);
  assert.equal(await p.cmd({ c: 'ncmAction', rid: 3, action: 'missing' }), false);
  // only actions registered as such, not what every object inherits
  assert.equal(await p.cmd({ c: 'ncmAction', action: 'constructor' }), false);
  assert.equal(await p.cmd({ c: 'ncmAction', action: 'toString' }), false);
  p.cmd({ c: 'rnpSettings', rid: 4 });
  assert.deepEqual(p.history.pushed, ['/hotComments/1'], 'actions with their own list push NCM 3 paths');
  assert.deepEqual(p.posts, [
    { t: 'reply', rid: 1, ok: true, data: { got: 3, id: '1810227452', hasReq: true, push: true } },
    { t: 'reply', rid: 2, ok: false, error: 'nope' },
    { t: 'reply', rid: 3, ok: false, error: 'no action missing' },
    { t: 'reply', rid: 4, ok: true, data: { a: '1' } },
  ]);
});

test('without the channel shim\'s tap, NCM\'s channel listeners are used', () => {
  const p = load({ tap: false });
  assert.deepEqual(p.registered.map(([c]) => c), ['audioplayer.onPlayProgress', 'audioplayer.onPlayState']);
  p.boot();
  p.cmd({ c: 'active', v: true });
  p.posts.length = 0;
  p.registered[0][1]('1810227452', '33.00', '1.0000');
  assert.equal(p.posts[0].t, 'progress');
  assert.equal(p.posts[0].pos, 33);
  p.registered[1][1]('1810227452', '1810227452|pause', 2);
  assert.deepEqual(p.posts.at(-1), { t: 'state', playing: false });
});

test('the local and empty cases read sensibly', () => {
  const p = load({ state: { playing: { resourceTrackId: '', playingState: 1, playingMode: 'playOrder', trackFileType: 'local', resourcePlayingQuality: '' } } });
  p.boot();
  p.cmd({ c: 'snapshot' });
  const s = p.posts.at(-1);
  assert.equal(s.track.id, '');
  assert.equal(s.track.local, true);
  assert.equal(s.track.quality, '');
  assert.equal(s.track.duration, 0);
  assert.equal(s.liked, false);
  assert.equal(s.mode, 'order');
  assert.equal(s.volume, 0.5);
  assert.equal(p.cmd({ c: 'seek', sec: 3 }), false, 'nothing loaded');
});

test('an open nobody answers opens NCM\'s own page: the injector is gone', () => {
  const p = load();
  p.boot();
  p.cmd({ c: 'active', v: true }); // the window was open when the injector died
  p.posts.length = 0;
  p.vinyl.next('opening');
  assert.equal(p.ofType('open').length, 1);
  p.advance(1400);
  assert.deepEqual(p.actions, []);
  p.advance(200);
  assert.deepEqual(p.actions, [{ type: 'playing/openVinylPage' }]);
  assert.ok(p.bodyClasses.has('bncm-stock-vinyl'), 'visible');
  assert.ok(!p.bodyClasses.has('bncm-lyrics-open'), 'the play bar is no longer slowed');
  // from now on NCM's page opens directly, and nothing is posted
  p.posts.length = 0;
  p.vinyl.next('opening');
  assert.deepEqual(p.vinyl.seen, ['opening']);
  p.progress(3);
  p.advance(5000);
  assert.deepEqual(p.posts, []);
});

test('an open answered by the relay keeps the window', () => {
  for (const answer of [{ c: 'active', v: true }, { c: 'fallback' }]) {
    const p = load();
    p.boot();
    p.vinyl.next('opening');
    p.advance(100);
    p.cmd({ c: 'active', v: false }); // the relay's reset on hello is no answer
    p.cmd(answer);
    p.actions.length = 0;
    p.advance(5000);
    assert.deepEqual(p.actions, [], JSON.stringify(answer));
  }
});

test('an answer that comes after the watchdog gave up makes later opens the window\'s again', () => {
  const p = load();
  p.boot();
  p.vinyl.next('opening');
  p.advance(1600); // a slow injector, not a gone one
  assert.deepEqual(p.actions, [{ type: 'playing/openVinylPage' }]);
  p.cmd({ c: 'active', v: true });
  assert.ok(p.bodyClasses.has('bncm-lyrics-open'));
  p.cmd({ c: 'active', v: false });
  p.vinyl.next('opening'); // NCM's page, opened by the watchdog, is still let through
  p.vinyl.next('closed');
  assert.ok(!p.bodyClasses.has('bncm-stock-vinyl'), 'NCM\'s page closed: hidden again');
  p.posts.length = 0;
  p.advance(1000);
  p.vinyl.next('opening');
  assert.equal(p.ofType('open').length, 1);
  // a detach is for good: no later active brings the window back
  p.cmd({ c: 'active', v: true });
  p.cmd({ c: 'detach' });
  p.cmd({ c: 'active', v: true });
  p.cmd({ c: 'active', v: false });
  p.posts.length = 0;
  p.advance(1000);
  p.vinyl.next('opening');
  assert.equal(p.ofType('open').length, 0);
});

test('an open before boot is done says hello first', () => {
  const p = load({ webpack: false });
  p.click(p.cover);
  assert.deepEqual(p.posts.map((m) => m.t), ['hello', 'open']);
  p.cmd({ c: 'active', v: true });
  p.boot();
  assert.equal(p.ofType('open').length, 1);
});

test('without NCM\'s modules, an unanswered open lets NCM\'s page open and stops collapsing it', () => {
  const p = load({ webpack: false, state: {} });
  p.boot();
  p.setState({ 'page:vinylPage': { pageState: 'opening' } });
  assert.equal(p.ofType('open').length, 1);
  p.advance(1600);
  assert.deepEqual(p.actions, [{ type: 'playing/openVinylPage' }]);
  p.setState({ 'page:vinylPage': { pageState: 'opened' } });
  p.advance(5000);
  assert.deepEqual(p.collapseBtn.events, [], 'NCM\'s page stays open');
  // a cover click is NCM's own again
  const e = p.click(p.cover);
  assert.equal(e.stopped, false);
});

test('detach: the injector stops, NCM keeps its own page and the play bar', () => {
  const p = load();
  p.boot();
  p.cmd({ c: 'active', v: true });
  p.posts.length = 0;
  assert.equal(p.cmd({ c: 'detach' }), true);
  assert.ok(!p.bodyClasses.has('bncm-lyrics-open'));
  assert.ok(p.bodyClasses.has('bncm-stock-vinyl'));
  assert.deepEqual(p.actions, [], 'NCM\'s page does not open by itself');
  p.progress(5);
  p.advance(1000);
  p.vinyl.next('opening');
  assert.deepEqual(p.vinyl.seen, ['opening']);
  assert.deepEqual(p.posts, []);
});

test('drawn: while the open window cannot be seen progress waits, and catches up after', () => {
  const p = load();
  p.boot();
  p.cmd({ c: 'active', v: true });
  p.emit('audioplayer.onPlayState', ['1810227452', '1810227452|resume', 1]);
  p.posts.length = 0;
  assert.equal(p.cmd({ c: 'drawn', v: false }), true);
  assert.ok(p.bodyClasses.has('bncm-lyrics-open'), 'still open');
  let pos = 30;
  for (let i = 0; i < 90; i++) { p.advance(33); pos += 0.033; p.progress(pos); }
  assert.deepEqual(p.ofType('progress'), []);
  // the rest still goes
  p.emit('audioplayer.onPlayState', ['1810227452', '1810227452|pause', 2]);
  assert.deepEqual(p.posts, [{ t: 'state', playing: false }]);
  p.cmd({ c: 'drawn', v: false });
  assert.equal(p.ofType('progress').length, 0);
  p.cmd({ c: 'drawn', v: true });
  const [pr] = p.ofType('progress');
  assert.equal(pr.force, true);
  assert.ok(Math.abs(pr.pos - pos) < 0.01, `the newest position, got ${pr.pos}`);
  p.cmd({ c: 'drawn', v: true });
  assert.equal(p.ofType('progress').length, 1, 'only when it changes');

  // opening again starts drawn
  p.cmd({ c: 'drawn', v: false });
  p.cmd({ c: 'active', v: false });
  p.cmd({ c: 'active', v: true });
  p.posts.length = 0;
  p.advance(33);
  p.progress(pos + 5);
  assert.equal(p.ofType('progress').length, 1);
});
