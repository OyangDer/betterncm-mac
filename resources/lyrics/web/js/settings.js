// The lyrics window's settings: its own keys, kept by the host in lyrics-settings.json. On first run
// they are seeded from RefinedNowPlayingNext's `refined-now-playing-*` keys in NCM's localStorage,
// so the look the user chose there carries over.
import { host, on, request, log } from './bus.js';
import { state, set } from './state.js';

export const DEFAULTS = Object.freeze({
  version: 1,
  // 歌词 · 显示
  showTranslation: false,
  showRomaji: true,
  karaoke: true,
  contributors: 'hide', // show | hover | hide
  // 歌词 · 大小
  fontSize: 48, // RNPN's lyric-font-size: px for a window as large as the screen, scaled down with it
  translationEm: 0.65, // 0: automatic, min(1em, 0.62em + 6px)
  translationWeight: 'semibold', // regular | medium | semibold; RNPN drew translations regular
  romajiEm: 0.6,
  bold: true,
  // 歌词 · 动效
  alignment: 50, // current line position, % of the lyric column's height
  karaokeAnim: 'float', // float | slide
  stagger: true,
  timing: 'smooth', // smooth | sharp | easeout | lazy
  zoom: true,
  fade: true,
  blur: true,
  glow: true,
  // 歌词 · 时间
  offset: 0, // ms, positive shows lyrics earlier
  // 外观
  scheme: 'dark', // auto | dark (white text) | light (black text)
  accent: 'off', // off | primary | secondary | tertiary
  textEffect: 'none', // none | shadow | glow
  showControls: true,
  // 背景
  bgType: 'blur', // blur | gradient | solid
  bgBlur: 110,
  bgDim: 19,
  gradientDynamic: true,
  gradientDim: 45,
  // 封面与信息
  coverShape: 'square', // square | round
  coverShadow: 'colorful', // colorful | plain
  coverPos: 'center', // center | bottomLeft
  subtitle: 'alias', // alias | trans | both | none
  // 字体
  font: 'custom', // system | custom
  fontList: ['PingFang SC'],
});

const ENUMS = {
  contributors: ['show', 'hover', 'hide'],
  translationWeight: ['regular', 'medium', 'semibold'],
  karaokeAnim: ['float', 'slide'],
  timing: ['smooth', 'sharp', 'easeout', 'lazy'],
  scheme: ['auto', 'dark', 'light'],
  accent: ['off', 'primary', 'secondary', 'tertiary'],
  textEffect: ['none', 'shadow', 'glow'],
  bgType: ['blur', 'gradient', 'solid'],
  coverShape: ['square', 'round'],
  coverShadow: ['colorful', 'plain'],
  coverPos: ['center', 'bottomLeft'],
  subtitle: ['alias', 'trans', 'both', 'none'],
  font: ['system', 'custom'],
};
const RANGES = {
  fontSize: [16, 72], translationEm: [0, 1.5], romajiEm: [0.3, 1.5], alignment: [20, 60],
  offset: [-10000, 10000], bgBlur: [0, 128], bgDim: [0, 100], gradientDim: [0, 100],
};

/** Coerce stored values to the schema; unknown keys are dropped. */
export function normalize(input) {
  const out = { ...DEFAULTS };
  if (!input || typeof input !== 'object') return out;
  for (const [k, def] of Object.entries(DEFAULTS)) {
    if (!(k in input)) continue;
    const v = input[k];
    if (ENUMS[k]) { if (ENUMS[k].includes(v)) out[k] = v; continue; }
    if (typeof def === 'boolean') { if (typeof v === 'boolean') out[k] = v; continue; }
    if (typeof def === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = RANGES[k] ? Math.min(RANGES[k][1], Math.max(RANGES[k][0], n)) : n;
      continue;
    }
    if (Array.isArray(def)) { if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()); continue; }
  }
  return out;
}

/** RNPN's keys (without the `refined-now-playing-` prefix) to B's settings. */
export function fromRnp(ls) {
  if (!ls || typeof ls !== 'object') return null;
  const b = (k) => (ls[k] == null ? undefined : ls[k] === 'true');
  const n = (k) => (ls[k] == null || ls[k] === '' ? undefined : Number(ls[k]));
  const s = {};
  const put = (k, v) => { if (v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))) s[k] = v; };
  put('showTranslation', b('show-translation'));
  put('showRomaji', b('show-romaji'));
  put('karaoke', b('use-karaoke-lyrics'));
  put('contributors', ls['lyric-contributors-display']);
  put('fontSize', n('lyric-font-size'));
  const tr = n('lyric-translation-size-em');
  if (tr !== undefined && tr !== 1) put('translationEm', tr); // 1em was RNPN's default; ours is automatic
  put('romajiEm', n('lyric-romaji-size-em'));
  put('bold', b('original-lyric-bold'));
  const al = n('current-lyric-alignment-percentage');
  if (al !== undefined) put('alignment', al <= 40 ? 30 : 50);
  put('karaokeAnim', ls['karaoke-animation']);
  put('stagger', b('lyric-stagger'));
  put('timing', ls['lyric-animation-timing']);
  put('zoom', b('lyric-zoom'));
  put('fade', b('lyric-fade'));
  put('blur', b('lyric-blur'));
  put('glow', b('lyric-glow'));
  put('offset', n('lyric-offset'));
  put('scheme', ls['color-scheme']);
  put('accent', ls['accent-color-variant']);
  if (b('text-glow')) s.textEffect = 'glow';
  else if (b('text-shadow')) s.textEffect = 'shadow';
  else if (ls['text-shadow'] != null || ls['text-glow'] != null) s.textEffect = 'none';
  const hide = b('hide-player-controls');
  if (hide !== undefined) s.showControls = !hide;
  const bt = ls['background-type'];
  if (bt) s.bgType = bt === 'gradient' ? 'gradient' : bt === 'solid' ? 'solid' : 'blur';
  put('bgBlur', n('bg-blur'));
  put('bgDim', n('bg-dim'));
  put('gradientDynamic', b('gradient-bg-dynamic'));
  put('gradientDim', n('bg-dim-for-gradient-bg'));
  const rect = b('rectangle-cover');
  if (rect !== undefined) s.coverShape = rect ? 'square' : 'round';
  const shadow = b('cover-blurry-shadow');
  if (shadow !== undefined) s.coverShadow = shadow ? 'colorful' : 'plain';
  const h = ls['horizontal-align'], v = ls['vertical-align'];
  if (h || v) s.coverPos = (h ?? 'left') === 'left' && (v ?? 'bottom') === 'bottom' ? 'bottomLeft' : 'center';
  if (b('hide-song-alias-name')) s.subtitle = 'none';
  else if (ls['song-alias-display-mode']) {
    s.subtitle = { 'alias-first': 'alias', 'translation-first': 'trans', both: 'both' }[ls['song-alias-display-mode']] || 'alias';
  }
  const custom = b('custom-font');
  if (custom !== undefined) s.font = custom ? 'custom' : 'system';
  // only a list RNPN has: none keeps ours
  if (ls['font-family'] != null) {
    try {
      const fl = JSON.parse(ls['font-family'] || '[]');
      if (Array.isArray(fl)) s.fontList = fl.map((f) => (typeof f === 'string' ? f : f?.name || f?.family)).filter(Boolean);
    } catch { /* none */ }
  }
  return normalize(s);
}

let saveTimer = 0;
export function update(patch) {
  const next = normalize({ ...state.settings, ...patch });
  set('settings', next);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => host('saveSettings', { data: next }), 300);
}

export function reset() {
  update({ ...DEFAULTS });
}

on('host.settings', async (m) => {
  if (m.data && typeof m.data === 'object') {
    set('settings', normalize(m.data));
    return;
  }
  // first run: carry RNPN's choices over
  set('settings', { ...DEFAULTS });
  try {
    const ls = await request('rnpSettings', {}, 8000);
    const seeded = fromRnp(ls);
    if (seeded) {
      log('settings seeded from RefinedNowPlayingNext');
      update(seeded);
      return;
    }
  } catch (e) {
    log('settings: no RNPN settings to seed from:', e.message);
  }
  update({});
});
