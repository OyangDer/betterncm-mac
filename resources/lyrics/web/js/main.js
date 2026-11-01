// The lyrics window's page: RNPN's now-playing page, rebuilt to draw cheaply (LYRICS-WINDOW.md).
import { host, ncmFetch, on, send, log } from './bus.js';
import { setPosition } from './clock.js';
import { mountLyrics } from './lyrics.js';
import { parseLyrics } from './parse.js';
import { mountSide, layoutSide } from './side.js';
import { mountAppearance } from './appearance.js';
import { mountTools } from './tools.js';
import { state, set, watch } from './state.js';
import './settings.js';

const LYRIC_API = (id) => `https://music.163.com/api/song/lyric/v1?tv=0&lv=0&rv=0&kv=0&yv=0&ytv=0&yrv=0&cp=false&id=${encodeURIComponent(id)}`;

export function collapse() {
  host('close');
}

// --- page ------------------------------------------------------------------------------------
async function loadTemplate() {
  const html = await (await fetch('template.html')).text();
  document.body.insertAdjacentHTML('afterbegin', html);
  // the lyric column is built by lyrics.js
  for (const sel of ['.rnp-lyrics', '.rnp-lyrics-switch', '.rnp-lyrics-scrollbar']) document.querySelector(`#rnp-view .lyric > ${sel}`)?.remove();
}

// RNPN's body classes that the settings do not change (its stylesheet keys on them).
// mq-playing is NCM's class for its now-playing page being shown, not for music playing.
const BASE_CLASSES = ['refined-now-playing', 'no-material-you-theme', 'is-osx-tag', 'rnp-lyric-page-open', 'mq-playing', 'no-exclusive-mode',
  'rnp-current-lyric-alignment-50', 'rnp-song-alias-display-alias-first'];

// --- colour scheme, accent, text effect, background, window states: appearance.js ----------------------

// --- lyrics for the current track -----------------------------------------------------------------
const lyricCache = new Map();
let lyricFor = '';
async function loadLyrics(id) {
  if (!id || id === '0' || id === lyricFor) return;
  lyricFor = id;
  if (lyricCache.has(id)) { set('lyrics', lyricCache.get(id)); return; }
  try {
    const raw = await ncmFetch(LYRIC_API(id));
    if (raw?.data === -400 || lyricFor !== id) return;
    const parsed = parseLyrics(raw, id);
    lyricCache.set(id, parsed);
    if (lyricCache.size > 20) lyricCache.delete(lyricCache.keys().next().value);
    set('lyrics', parsed);
  } catch (e) {
    // RNPN keeps the previous lyrics when a fetch fails; so do we
    lyricFor = '';
    log('lyrics fetch failed:', id, String(e?.message || e));
  }
}

// --- messages ---------------------------------------------------------------------------------------
function applySnapshot(m) {
  if (m.track) set('track', m.track);
  if (typeof m.playing === 'boolean') set('playing', m.playing);
  if (typeof m.liked === 'boolean') set('liked', m.liked);
  if (m.mode) set('mode', m.mode);
  if (typeof m.volume === 'number') set('volume', m.volume);
  set('roaming', !!m.roaming);
  if (m.dislikeIcon) set('dislikeIcon', m.dislikeIcon);
}

on('snapshot', applySnapshot);
on('track', (m) => { const { t, ...track } = m; set('track', track); });
on('liked', (m) => set('liked', !!m.v));
on('mode', (m) => set('mode', m.v));
on('volume', (m) => set('volume', Number(m.v)));
on('roaming', (m) => { set('roaming', !!m.v); if (m.icon) set('dislikeIcon', m.icon); });
on('hello', () => send('snapshot'));
on('open', (m) => { if (m.version) set('version', m.version); set('view', state.view || 'lyrics'); });
on('host.window', (m) => {
  const was = state.window.visible;
  set('window', { w: m.w, h: m.h, visible: !!m.visible, fullscreen: !!m.fullscreen });
  document.body.classList.toggle('bncm-fullscreen', !!m.fullscreen);
  if (m.visible && !was) send('snapshot');
});
on('host.cover', (m) => {
  set('cover', { url: m.url, cover: m.cover, bg: m.bg });
});

watch('track', (t, old) => {
  if (!t) return;
  if (!old || t.id !== old.id) { setPosition(0, 'jump'); loadLyrics(t.id); }
});

// --- keyboard ---------------------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]')) return;
  if (e.key === 'Escape') {
    if (document.dispatchEvent(new CustomEvent('bncm-escape', { cancelable: true }))) collapse();
    e.preventDefault();
  } else if (e.key === 'w' && e.metaKey) {
    collapse();
    e.preventDefault();
  } else if (e.key === ' ' && !e.metaKey && !e.ctrlKey) {
    send('toggle');
    e.preventDefault();
  }
});

// --- start -----------------------------------------------------------------------------------------
async function start() {
  await loadTemplate();
  document.body.classList.add(...BASE_CLASSES);
  mountSide({ collapse });
  mountLyrics(document.querySelector('#rnp-view .lyric'));
  mountTools({ collapse });
  mountAppearance();
  document.querySelector('#rnp-view .rnp-control-thumb')?.addEventListener('click', collapse);
  // RNPN shows the bottom handle when the pointer is near the bottom edge
  document.addEventListener('mousemove', (e) => {
    document.body.classList.toggle('rnp-control-thumb-visible', innerHeight - e.clientY < 80);
  }, { passive: true });
  window.addEventListener('resize', () => layoutSide());
  host('ready');
  send('snapshot');
}

start().catch((e) => log('start failed:', String(e?.stack || e)));
