// Copy mode: RNPN's lyric overview. The whole lyric as a static list you can select and copy, in
// place of the animated lyric column (which keeps running, hidden, so it comes back where it is).
// The current line is lit as the song plays and kept in view unless you are scrolling or
// selecting; a click on a line (or a right click, as in RNPN) plays from there; 复制全部 copies the
// whole text. The same button or Esc leaves.
import { host, send } from './bus.js';
import { now, onClock } from './clock.js';
import { isMenuOpen, loadMenuCss, toast } from './menu.js';
import { state, set, watch } from './state.js';

const HOLD_MS = 3000; // after a wheel or a selection, before the list follows the song again
const DBL_MS = 250; // a click waits this long for a second click (word selection) before seeking
const COPY_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="6.5" y="6.5" width="10" height="10.5" rx="2"/><path d="M13.5 6.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6.5a2 2 0 0 0 2 2h1.5" stroke-linecap="round"/></svg>';

let on = false;
let wrap = null; // .bncm-copy in the lyric column
let scroller = null;
let list = null;
let rows = []; // [{el, line, i}]
let cur = -1;
let unsynced = false;
let holdUntil = 0;
let selecting = false;
let clickTimer = 0;
let lineTimer = 0;
let offClock = null;

const S = () => state.settings || {};
const lyricTime = () => now() + (S().offset || 0);

/** Called by tools.js; returns the new state. */
export function toggleCopyMode(v = !on) {
  if (v === on) return on;
  on = v;
  if (on) enter(); else leave();
  return on;
}

export function isCopyMode() { return on; }

function enter() {
  // the list is measured to keep the current line in view, so again once the stylesheet applies
  loadMenuCss().then(() => { if (on) { place(); update(true); } });
  ensureDom();
  if (state.view !== 'lyrics') set('view', 'lyrics');
  document.body.classList.add('bncm-copy-mode');
  build();
  offClock = onClock(() => update(false));
  document.addEventListener('bncm-escape', onEscape);
  window.addEventListener('keydown', onKey, true);
  syncButton();
}

function leave() {
  document.body.classList.remove('bncm-copy-mode');
  offClock?.();
  offClock = null;
  clearTimeout(lineTimer);
  clearTimeout(clickTimer);
  document.removeEventListener('bncm-escape', onEscape);
  window.removeEventListener('keydown', onKey, true);
  getSelection()?.removeAllRanges();
  if (list) list.textContent = '';
  rows = [];
  cur = -1;
  syncButton();
}

// tools.js sets the button's state from what toggleCopyMode returns; leaving by Esc or by another
// view has to clear it here.
function syncButton() {
  document.querySelector('#rnp-view .bncm-top-copy')?.classList.toggle('bncm-on', on);
}

function onEscape(e) {
  // the "···" menu, when open, takes Esc first (a closing menu stays in the DOM for its fade, so
  // ask menu.js rather than the DOM)
  if (!on || e.defaultPrevented || isMenuOpen()) return;
  e.preventDefault();
  toggleCopyMode(false);
}

// ⌘A selects the lyric only (RNPN's 全选); ⌘C goes through the host, since the window has no Edit
// menu to copy with.
function onKey(e) {
  if (!e.metaKey || e.altKey || e.ctrlKey) return;
  // a text field (the comment box, the settings) keeps its own select-all and copy
  if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]')) return;
  const k = e.key.toLowerCase();
  if (k === 'a') {
    const r = document.createRange();
    r.selectNodeContents(list);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    holdUntil = performance.now() + HOLD_MS;
  } else if (k === 'c') {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !scroller.contains(sel.anchorNode)) return;
    host('copy', { text: sel.toString() });
    toast('已复制');
  } else {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
}

// --- DOM ---------------------------------------------------------------------------------------------
function ensureDom() {
  if (wrap) { place(); return; }
  const col = document.querySelector('#rnp-view .lyric');
  wrap = document.createElement('div');
  wrap.className = 'bncm-copy';
  wrap.innerHTML = `<div class="rnp-lyrics rnp-lyrics-overview-container" tabindex="-1"><div class="rnp-lyrics-overview"></div></div>
    <div class="bncm-copy-actions"><button type="button" class="bncm-copy-btn" title="复制全部歌词">${COPY_ICON}<span>复制全部</span></button></div>`;
  col.append(wrap);
  scroller = wrap.firstElementChild;
  list = scroller.firstElementChild;
  wrap.querySelector('.bncm-copy-btn').addEventListener('click', (e) => { e.stopPropagation(); copyAll(); });

  scroller.addEventListener('wheel', () => { holdUntil = performance.now() + HOLD_MS; }, { passive: true });
  scroller.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    selecting = true;
    wrap.classList.add('selecting');
  });
  window.addEventListener('pointerup', () => {
    if (!selecting) return;
    selecting = false;
    wrap.classList.remove('selecting');
    holdUntil = performance.now() + HOLD_MS;
  });
  scroller.addEventListener('click', onClick);
  scroller.addEventListener('dblclick', () => clearTimeout(clickTimer));
  scroller.addEventListener('contextmenu', (e) => {
    const row = rowOf(e.target);
    if (!row) return;
    e.preventDefault();
    seekTo(row);
  });
  new ResizeObserver(() => { if (on) place(); }).observe(col);
  place();
}

// Over the lyric column's own box (RNPN's .rnp-lyrics, which compat.css narrows).
function place() {
  const box = document.querySelector('#rnp-view .lyric > .rnp-lyrics:not(.rnp-lyrics-overview-container)');
  if (!box || !wrap) return;
  const w = wrap.getBoundingClientRect();
  const r = box.getBoundingClientRect();
  if (!r.width) return;
  wrap.style.setProperty('--bncm-copy-left', `${r.left - w.left}px`);
  wrap.style.setProperty('--bncm-copy-top', `${r.top - w.top}px`);
  wrap.style.setProperty('--bncm-copy-width', `${r.width}px`);
  wrap.style.setProperty('--bncm-copy-height', `${r.height}px`);
  wrap.style.setProperty('--bncm-copy-right', `${Math.max(16, w.right - r.right + 30)}px`);
}

function build() {
  if (!on || !list) return;
  clearTimeout(lineTimer);
  const lyr = state.lyrics;
  const lines = lyr?.lyrics || [];
  unsynced = !!lyr?.unsynced;
  wrap.classList.toggle('unsynced', unsynced);
  const s = S();
  const frag = document.createDocumentFragment();
  rows = [];
  if (!lines.length) {
    const el = document.createElement('div');
    el.className = 'rnp-lyrics-overview-line unsynced-indicator';
    el.textContent = '暂无歌词';
    frag.append(el);
  } else if (unsynced) {
    const el = document.createElement('div');
    el.className = 'rnp-lyrics-overview-line unsynced-indicator';
    el.textContent = '歌词暂不支持滚动';
    frag.append(el);
  }
  lines.forEach((line, i) => {
    if (unsynced && i === 0) return;
    const el = document.createElement('div');
    el.className = 'rnp-lyrics-overview-line';
    if (line.isInterlude) el.classList.add('interlude');
    else {
      addText(el, 'original', line.originalLyric);
      if (s.showRomaji && line.romanLyric) addText(el, 'romaji', line.romanLyric);
      if (s.showTranslation && line.translatedLyric) addText(el, 'translation', line.translatedLyric);
    }
    el.dataset.i = i;
    frag.append(el);
    rows.push({ el, line, i });
  });
  list.textContent = '';
  list.append(frag);
  cur = -1;
  holdUntil = 0;
  place();
  update(true);
}

function addText(el, kind, text) {
  const d = document.createElement('div');
  d.className = `rnp-lyrics-overview-line-${kind}`;
  d.textContent = text;
  el.append(d);
}

// --- the current line ---------------------------------------------------------------------------------
function currentAt(t) {
  const L = state.lyrics?.lyrics || [];
  let c = -1;
  for (let i = 0; i < L.length; i++) { if (L[i].time <= t) c = i; else break; }
  return c;
}

function update(instant) {
  if (!on || !rows.length || unsynced) return;
  clearTimeout(lineTimer);
  const t = lyricTime();
  const c = currentAt(t);
  if (c !== cur || instant) {
    cur = c;
    for (const r of rows) {
      r.el.classList.toggle('current', r.i === c);
      r.el.classList.toggle('passed', r.i < c);
    }
    follow(instant);
  }
  // progress messages come four times a second while playing; between them, wake for the next line
  const L = state.lyrics.lyrics;
  const next = L[c + 1];
  if (state.playing && next) lineTimer = setTimeout(() => update(false), Math.min(Math.max(next.time - t, 16), 2 ** 31 - 1));
}

function follow(instant) {
  if (selecting || performance.now() < holdUntil) return;
  const sel = getSelection();
  if (sel && !sel.isCollapsed && scroller.contains(sel.anchorNode)) return;
  const row = rows.find((r) => r.i === cur) || (cur < 0 ? rows[0] : null);
  if (!row) return;
  const top = row.el.offsetTop - scroller.clientHeight / 2 + row.el.clientHeight / 2;
  scroller.scrollTo({ top, behavior: instant ? 'auto' : 'smooth' });
}

// --- clicks ----------------------------------------------------------------------------------------------
function rowOf(target) {
  const el = target instanceof Element && target.closest('.rnp-lyrics-overview-line');
  if (!el || unsynced || el.classList.contains('unsynced-indicator')) return null;
  const row = rows.find((r) => r.el === el);
  return row && !row.line.isInterlude ? row : null;
}

function onClick(e) {
  const row = rowOf(e.target);
  clearTimeout(clickTimer);
  if (!row || e.detail > 1) return;
  // a click that ends a selection only selects
  const sel = getSelection();
  if (sel && !sel.isCollapsed) return;
  clickTimer = setTimeout(() => {
    const s = getSelection();
    if (s && !s.isCollapsed) return;
    seekTo(row);
  }, DBL_MS);
}

function seekTo(row) {
  send('seek', { sec: Math.max(0, (row.line.time + 50 - (S().offset || 0)) / 1000) });
  if (!state.playing) send('toggle');
  holdUntil = 0;
}

// --- copy ------------------------------------------------------------------------------------------------
export function lyricText() {
  const lines = state.lyrics?.lyrics || [];
  const s = S();
  const groups = [];
  let multi = false;
  lines.forEach((l, i) => {
    if (l.isInterlude || (state.lyrics.unsynced && i === 0)) return;
    const g = [l.originalLyric];
    if (s.showRomaji && l.romanLyric) g.push(l.romanLyric);
    if (s.showTranslation && l.translatedLyric) g.push(l.translatedLyric);
    if (g.length > 1) multi = true;
    groups.push(g.join('\n'));
  });
  return groups.join(multi ? '\n\n' : '\n');
}

function copyAll() {
  const text = lyricText();
  if (!text.trim()) { toast('没有可复制的歌词'); return; }
  host('copy', { text });
  toast('已复制全部歌词');
}

// --- changes ---------------------------------------------------------------------------------------------
watch('lyrics', () => { if (on) build(); });
watch('settings', (s, old) => {
  if (on && (!old || s.showTranslation !== old.showTranslation || s.showRomaji !== old.showRomaji)) build();
  else if (on && s.offset !== old?.offset) update(true);
});
watch('playing', () => { if (on) update(false); });
watch('view', (v) => { if (on && v !== 'lyrics') toggleCopyMode(false); });
watch('window', () => { if (on) place(); });
