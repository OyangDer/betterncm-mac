// 百科 / 相似推荐 / 评论: views that take the lyric column's place (compat-rnp-panels.js put NCM's own
// pages there; here they are rebuilt from the same data). Each panel module registers itself:
//   registerPanel(id, { mount(el), show(track), hide() })
// mount runs once with the panel's own container; show runs whenever the panel is shown or the track
// changes while it shows; hide when another view takes over.
import { state, set, watch } from '../state.js';

const panels = new Map(); // id -> {def, el, mounted}
const cssLoaded = new Set();
/** Load a panel's stylesheet once (css/panel-<id>.css). */
export function loadCss(href) {
  if (cssLoaded.has(href)) return;
  cssLoaded.add(href);
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.append(l);
}
let host = null; // the panel area over the lyric column
let current = 'lyrics';
const MODULES = { baike: './baike.js', similar: './similar.js', comment: './comment.js' };

export function registerPanel(id, def) {
  panels.set(id, { def, el: null, mounted: false });
}

function ensureHost() {
  if (host) return host;
  host = document.createElement('div');
  host.className = 'bncm-panel-host';
  // In RNPN's .wrap, beside the lyric column: it rises with the page on open, and a box inside .lyric
  // would be moved by the column's own entrance and would clip at its edges.
  document.querySelector('#rnp-view .wrap').append(host);
  return host;
}

/** The lyric column's box minus RNPN's 30px padding, below the top-right controls (as compat-rnp-panels.js).
 * Layout offsets, not client rects: those include the entrance transforms while the window opens. */
export function placeHost() {
  if (!host) return;
  const lyrics = document.querySelector('#rnp-view .rnp-lyrics');
  const col = document.querySelector('#rnp-view .lyric');
  if (!lyrics || !col || col.offsetParent !== host.parentElement) return;
  const left = col.offsetLeft + lyrics.offsetLeft;
  const top = col.offsetTop + lyrics.offsetTop;
  const TOP_CLEAR = 56;
  const clear = Math.max(top, TOP_CLEAR);
  host.style.setProperty('--bncm-panel-left', `${left + 30}px`);
  host.style.setProperty('--bncm-panel-top', `${clear}px`);
  host.style.setProperty('--bncm-panel-width', `${Math.max(0, lyrics.offsetWidth - 60)}px`);
  host.style.setProperty('--bncm-panel-height', `${Math.max(0, top + lyrics.offsetHeight - clear)}px`);
}

// The switcher's order (tools.js VIEWS): a view further right slides in from the right, the one
// it replaces out to the left, and the other way round (css/panels.css).
const ORDER = ['lyrics', 'baike', 'similar', 'comment'];
const LEAVE_MS = 260;

// Plays a CSS animation class on an element once (again, if it is still on). Taken off when it
// ends: the rules key on the direction, and a later switch would replay it.
function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  const done = (e) => {
    if (e.target !== el) return;
    el.classList.remove(cls);
    el.removeEventListener('animationend', done);
    el.removeEventListener('animationcancel', done);
  };
  el.addEventListener('animationend', done);
  el.addEventListener('animationcancel', done);
}

export async function showView(view) {
  if (view !== 'lyrics' && !MODULES[view]) view = 'lyrics';
  const prev = current;
  current = view;
  if (prev !== view) document.body.dataset.bncmDir = ORDER.indexOf(view) > ORDER.indexOf(prev) ? 'fwd' : 'back';
  document.body.dataset.bncmView = view;
  if (prev !== 'lyrics' && prev !== view) panels.get(prev)?.def.hide?.();
  if (view === 'lyrics' && prev !== 'lyrics') {
    for (const el of document.querySelectorAll('#rnp-view .lyric > :is(.rnp-lyrics, .rnp-lyrics-scrollbar)')) replay(el, 'bncm-view-in');
  }
  if (view === 'lyrics') { host?.classList.remove('shown'); return; }
  ensureHost();
  placeHost();
  if (!panels.has(view)) {
    try { await import(MODULES[view]); } catch (e) { console.error('panel failed to load', view, e); set('view', 'lyrics'); return; }
  }
  if (current !== view) return;
  const p = panels.get(view);
  if (!p) { set('view', 'lyrics'); return; }
  if (!p.mounted) {
    p.el = document.createElement('div');
    p.el.className = `bncm-panel bncm-panel-${view}`;
    host.append(p.el);
    p.def.mount(p.el);
    p.mounted = true;
  }
  // panel to panel: the old one stays a moment, sliding out, while the new one slides in
  const old = prev !== 'lyrics' && prev !== view ? panels.get(prev)?.el : null;
  if (old && host.classList.contains('shown')) {
    old.classList.add('leaving');
    clearTimeout(old._leave);
    old._leave = setTimeout(() => old.classList.remove('leaving'), LEAVE_MS);
    replay(p.el, 'bncm-view-in');
  }
  for (const [id, q] of panels) {
    q.el?.classList.toggle('active', id === view);
    if (id === view && q.el) { clearTimeout(q.el._leave); q.el.classList.remove('leaving'); }
  }
  host.classList.add('shown');
  p.def.show(state.track);
}

watch('track', (t, old) => {
  if (current === 'lyrics' || !t || (old && t.id === old.id)) return;
  // a song without comments (local, no thread) or with no 百科 etc.: the panel shows its empty state
  panels.get(current)?.def.show(t);
});
watch('window', () => placeHost());
window.addEventListener('resize', () => placeHost());

// --- wheel gestures (compat-rnp-panels.js onWheel / onPanelWheel) ------------------------------
// Scrolling down on the cover side opens the comments; in the comments, a new upward gesture that
// starts with the list at its top goes back to the lyrics (a trackpad's momentum does not count).
const WHEEL_TO_COMMENTS = 160;
const WHEEL_RESET_MS = 400;
const GESTURE_GAP_MS = 250;
const BACK_TO_LYRICS = 240;
let wheelSum = 0;
let wheelTimer = 0;
let lastPanelWheel = -Infinity;
let gestureAtTop = false;
let upSum = 0;

function commentsAvailable() {
  const t = state.track;
  return !!(t && t.id && !t.local && t.threadId);
}

document.addEventListener('wheel', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  if (current === 'lyrics') {
    if (e.deltaY <= 0 || t.closest('.rnp-lyrics, .bncm-settings, .rnp-window-topbar, .bncm-menu')) return;
    const lyrics = document.querySelector('#rnp-view .rnp-lyrics')?.getBoundingClientRect();
    if (!lyrics?.width || e.clientX >= lyrics.left || !commentsAvailable()) return;
    wheelSum += e.deltaY;
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { wheelSum = 0; }, WHEEL_RESET_MS);
    if (wheelSum >= WHEEL_TO_COMMENTS) { wheelSum = 0; set('view', 'comment'); }
    return;
  }
  if (current !== 'comment' || !t.closest('.bncm-panel-comment')) return;
  const list = document.querySelector('.bncm-panel-comment .bncm-scroll');
  const now = performance.now();
  if (now - lastPanelWheel > GESTURE_GAP_MS) { gestureAtTop = !!list && list.scrollTop <= 0; upSum = 0; }
  lastPanelWheel = now;
  if (!gestureAtTop || e.deltaY >= 0) { if (e.deltaY > 0) gestureAtTop = false; return; }
  upSum -= e.deltaY;
  if (upSum >= BACK_TO_LYRICS) { upSum = 0; gestureAtTop = false; set('view', 'lyrics'); }
}, { passive: true });
