// The cover column of RNPN's page: cover, title, song info, progress, controls and volume, in
// RNPN's own DOM (template.html) so its stylesheet and our compat CSS draw it exactly as before.
import { host, send } from './bus.js';
import { now, onClock } from './clock.js';
import { ICONS, QUALITY } from './icons.js';
import { state, watch } from './state.js';

const $ = (sel) => document.querySelector(sel);
const P = '#rnp-view .g-singlec-ct .n-single';
let els;
let dragging = false;
let progressTimer = 0;

export function mountSide({ collapse }) {
  els = {
    gsingle: $('#rnp-view .g-single'),
    wrap: $(`${P} .wrap`),
    sd: $(`${P} .sd`),
    cdimg: $(`${P} .cdimg`),
    img: $(`${P} .cdimg img`),
    fav: $(`${P} .rnp-cover-favorite-button`),
    mn: $(`${P} .mn`),
    title: $(`${P} .mn .head .inf .title`),
    name: $(`${P} .mn .head .inf .title .name`),
    nameInner: $(`${P} .mn .head .inf .title .name-inner`),
    nameDup: $(`${P} .mn .head .inf .title .name-duplicate`),
    track: $(`${P} .mn .head .inf .title .name-marquee-track`),
    alias: $(`${P} .mn .head .inf .info .alias`),
    ul: $(`${P} .mn .head .inf .info ul.playfrom`),
    more: $(`${P} .rnp-info-more-button`),
    slider: $(`${P} .rnp-amll-progress-slider`),
    thumb: $(`${P} .rnp-amll-progress-slider .thumb`),
    tips: $(`${P} .am-music-progress-tips`),
    quality: $(`${P} .rnp-audio-quality`),
    mode: $(`${P} .rnp-amll-play-mode`),
    prev: $(`${P} .am-music-track-prev`),
    play: $(`${P} .am-music-play`),
    next: $(`${P} .am-music-track-next`),
    playlist: $(`${P} .rnp-amll-playlist`),
    controls: $(`${P} .am-music-controls`),
    vol: $(`${P} .am-music-volume-controls`),
    volSlider: $(`${P} .rnp-amll-volume-slider`),
    volThumb: $(`${P} .rnp-amll-volume-slider .thumb`),
    bg: $('#rnp-view .rnp-background-blur'),
  };
  els.fav.addEventListener('click', (e) => { e.stopPropagation(); send('like'); });
  els.prev.addEventListener('click', () => send('prev'));
  els.next.addEventListener('click', () => send('next'));
  els.play.addEventListener('click', () => send('toggle'));
  els.mode.addEventListener('click', () => send('mode'));
  els.playlist.addEventListener('click', () => { send('playlist'); collapse(); });
  els.more.addEventListener('click', (e) => {
    e.stopPropagation();
    import('./menu.js').then((m) => m.openMenu?.(els.more, { collapse })).catch((err) => console.error('menu unavailable', err));
  });
  addDislike(collapse);
  els.ul.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-hash]');
    if (!a) return;
    e.preventDefault();
    send('nav', { hash: a.dataset.hash });
    collapse();
  });
  bindSlider(els.slider, (p) => {
    const d = state.track?.duration || 0;
    if (d > 0) send('seek', { sec: p * d });
  }, (p) => setProgressUi(p * (state.track?.duration || 0)));
  bindSlider(els.volSlider, (p) => send('volume', { v: p }), (p) => { els.volThumb.style.width = `${p * 100}%`; });
  for (const s of [els.slider, els.volSlider]) {
    s.addEventListener('mouseenter', () => s.classList.add('hovered'));
    s.addEventListener('mouseleave', () => s.classList.remove('hovered'));
  }
  // the speaker icon that opens the volume slider (compat-rnp-layout.js)
  if (!els.vol.querySelector('.bncm-vol-btn')) {
    const btn = document.createElement('span');
    btn.className = 'bncm-vol-btn';
    btn.setAttribute('aria-hidden', 'true');
    btn.innerHTML = ICONS.volumeHigh;
    els.vol.append(btn);
  }

  watch('track', renderTrack);
  watch('liked', renderLiked);
  watch('mode', renderMode);
  watch('playing', renderPlaying);
  watch('volume', (v) => { if (!dragging) els.volThumb.style.width = `${(v ?? 0.5) * 100}%`; });
  watch('roaming', (v) => document.body.classList.toggle('bncm-roaming', !!v));
  watch('cover', renderCover);
  watch('settings', (s, old) => {
    if (!old || s.subtitle !== old.subtitle) renderAlias();
    applyCoverSettings();
  });
  watch('window', () => { layoutSide(); fitTitle(true); });
  onClock(() => scheduleProgress());
  els.img.addEventListener('load', () => { els.cdimg.classList.remove('loading'); layoutSide(); });
  new ResizeObserver(() => { layoutSide(); placeVolume(); }).observe(els.wrap);
  renderMode(state.mode);
  renderPlaying(state.playing);
  renderLiked(state.liked);
}

// --- RNPN's side column measurement (jh, B@711252) -------------------------------------------
export function layoutSide() {
  const e = els.gsingle;
  const r = els.wrap.getBoundingClientRect();
  e.style.setProperty('--rnp-v3-meta-offset-x', '0px');
  e.style.setProperty('--rnp-v3-meta-offset-y', '0px');
  const o = els.sd.getBoundingClientRect();
  if (!r.width || !r.height || !o.width || !o.height) return;
  const inset = Math.round(Math.min(Math.max(0.018 * r.width, 12), 20));
  const a = Math.min(520, Math.max(360, 0.4 * r.width));
  const s = Math.max(o.width + 24, r.width - a);
  const c = Math.max(o.width + 24, Math.min(s, 1.7 * o.width));
  const left = Math.round(Math.min(inset, Math.max(c - o.width, 0)));
  const center = Math.round(Math.max((c - o.width) / 2, 0));
  e.style.setProperty('--rnp-v3-side-inset', `${inset}px`);
  e.style.setProperty('--rnp-v3-side-width', `${Math.round(c)}px`);
  e.style.setProperty('--rnp-v3-side-offset-x', `${document.body.classList.contains('horizontal-align-center') ? center : left}px`);
  placeVolume();
}

// The volume control sits left of the more button (compat-rnp-layout.js attach()).
function placeVolume() {
  const m = els.mn.getBoundingClientRect();
  const b = els.more.getBoundingClientRect();
  if (!m.width || !b.width) return;
  els.vol.style.setProperty('--bncm-vol-top', `${b.top - m.top}px`);
  els.vol.style.setProperty('--bncm-vol-right', `${m.right - b.left + 8}px`);
}

// --- track ----------------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderTrack(t, old) {
  if (!t) return;
  if (!old || t.title !== old.title) {
    els.nameInner.textContent = t.title || 'Unknown Song';
    fitTitle(true);
  }
  renderAlias();
  const arts = t.artists?.length ? t.artists : [{ id: '', name: 'Unknown Artist' }];
  const artistHtml = arts.map((a) => (a.id && a.id !== '0'
    ? `<a class="rnp-artist-link" data-hash="#/m/artist/?id=${esc(a.id)}" href="#"><span>${esc(a.name)}</span></a>`
    : `<span>${esc(a.name)}</span>`)).join('<span class="rnp-line-separator">/</span>');
  const al = t.album?.name || 'Unknown Album';
  const albumHtml = t.album?.id && t.album.id !== '0'
    ? `<a class="rnp-album-link rnp-static-line-album" data-hash="#/m/album/?id=${esc(t.album.id)}" href="#"><span>${esc(al)}</span></a>`
    : `<span>${esc(al)}</span>`;
  const idHtml = t.id ? `<a data-hash="#/m/song/?id=${esc(t.id)}" href="#"><span>歌曲 ID ${esc(t.id)}</span></a>` : '<span>网易云音乐</span>';
  els.ul.innerHTML = `<li class="rnp-artist-line">${artistHtml}</li><li>${albumHtml}</li><li class="rnp-song-id-line">${idHtml}</li>`;
  renderQuality(t);
  if (!old || t.cover !== old.cover) requestCover();
  scheduleProgress();
  layoutSide();
}

function renderAlias() {
  const t = state.track;
  if (!t) return;
  const mode = state.settings?.subtitle || 'alias';
  let text = '';
  if (mode === 'alias') text = t.alias || t.trans;
  else if (mode === 'trans') text = t.trans || t.alias;
  else if (mode === 'both') text = [...new Set([t.alias, t.trans].filter(Boolean))].join(' / ');
  els.alias.textContent = text || ' ';
  els.alias.classList.toggle('empty', !text);
}

// RNPN's quality badge (Km, B@665464)
function qualityOf(t) {
  if (t.envSound === 'dolby') return 'dolbyatmos';
  if (t.fileType === 'local') return 'local';
  const q = Number(t.quality);
  if (!Number.isFinite(q) || t.quality === '') return 'local';
  if (q <= 192) return 'normal';
  if (q <= 320) return 'high';
  if (q <= 999) return 'lossless';
  return 'hires';
}

function renderQuality(t) {
  const q = qualityOf(t);
  const def = QUALITY[q];
  els.quality.className = `rnp-audio-quality${def ? ` rnp-audio-quality-${q}` : ' is-empty'}`;
  els.quality.innerHTML = def ? `<span class="rnp-audio-quality-icon" aria-hidden="true">${def.markup}</span>` : '';
  els.quality.title = def?.label || '';
}

// --- title size and marquee (Eg / Lg, B@684900) ------------------------------------------------
let titleText = '';
let titleStyle = null;
function fitTitle(force) {
  const text = els.nameInner.textContent;
  if (!force && text === titleText) return;
  titleText = text;
  if (!titleStyle) { titleStyle = document.createElement('style'); document.head.append(titleStyle); }
  const probe = document.createElement('div');
  Object.assign(probe.style, { position: 'absolute', top: '-9999px', left: '-9999px', width: 'auto', height: 'auto', whiteSpace: 'nowrap', fontWeight: '700', fontFamily: 'var(--bncm-font-semibold)' }); // the face the title is drawn in (app.css)
  probe.innerText = text;
  document.body.append(probe);
  const cap = Math.max(Math.min(0.045 * document.body.clientHeight, 52), 34);
  const width = els.name.clientWidth || els.title.clientWidth;
  if (!width) { probe.remove(); return; }
  let lo = 22;
  let hi = Math.ceil(cap) + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    probe.style.fontSize = `${mid}px`;
    if (probe.clientWidth <= width) lo = mid + 1; else hi = mid;
  }
  probe.remove();
  const size = Math.max(Math.min(lo - 1, cap), 22);
  titleStyle.textContent = `#rnp-view .g-singlec-ct .n-single .mn .head .inf .title h1 { font-size: ${size}px !important; }`;
  requestAnimationFrame(marquee);
}

function marquee() {
  const n = els.name;
  const l = n.clientWidth;
  const text = els.nameInner.textContent || '';
  const cs = getComputedStyle(els.nameInner);
  const probe = document.createElement('span');
  probe.textContent = text.replace(/ /g, ' ').trim();
  Object.assign(probe.style, { position: 'absolute', left: '-99999px', top: '-99999px', visibility: 'hidden', whiteSpace: 'nowrap',
    font: cs.font, fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontFamily: cs.fontFamily, letterSpacing: cs.letterSpacing });
  document.body.append(probe);
  const c = probe.getBoundingClientRect().width;
  probe.remove();
  const gap = Math.max(12, Math.min(Math.round(0.045 * l), 20));
  const scroll = l > 0 && c - l > 1;
  els.nameDup.textContent = scroll ? text : '';
  n.style.setProperty('--scroll-gap', `${gap}px`);
  if (scroll) { els.track.style.transform = ''; n.classList.add('scroll'); } else { n.classList.remove('scroll'); els.track.style.transform = 'translateX(0)'; }
  n.style.setProperty('--scroll-distance', `${Math.max(c + gap, 0)}px`);
  n.style.setProperty('--scroll-speed', `${Math.max((c + gap) / 30, 6)}s`);
}

// --- cover and background ------------------------------------------------------------------------
export function coverUrl(url) {
  if (!url || url.startsWith('data:image/gif')) return 'https://p1.music.126.net/UeTuwE7pvjBpypWLudqukA==/3132508627578625.jpg';
  const size = 800;
  if (/thumbnail=\d+y\d+/.test(url)) return url.replace(/thumbnail=\d+y\d+/, `thumbnail=${size}y${size}`);
  if (/([?&])param=\d+y\d+/.test(url)) return url.replace(/([?&])param=\d+y\d+/, `$1param=${size}y${size}`);
  if (/music\.126\.net/i.test(url)) return `${url}${url.includes('?') ? '&' : '?'}param=${size}y${size}`;
  return url;
}

export function requestCover() {
  const t = state.track;
  if (!t) return;
  const s = state.settings || {};
  const light = state.scheme === 'light';
  const url = coverUrl(t.cover);
  // a new cover is shown as loading until it arrives; a background-only re-render keeps the cover
  if (state.cover?.url !== url) els.cdimg.classList.add('loading');
  host('cover', { url, dim: (s.bgDim ?? 55) / 100, overlay: light ? '#fff' : '#000', blur: s.bgBlur ?? 90 });
}

function renderCover(c) {
  if (!c) return;
  if (c.cover && els.img.getAttribute('src') !== c.cover) {
    els.img.src = c.cover;
    if (els.img.complete) els.cdimg.classList.remove('loading');
  }
  if (c.bg) els.bg.style.backgroundImage = `url("${c.bg}")`;
  applyCoverSettings();
}

function applyCoverSettings() {
  const s = state.settings || {};
  const b = document.body.classList;
  b.toggle('rectangle-cover', s.coverShape !== 'round');
  const center = s.coverPos !== 'bottomLeft';
  b.toggle('horizontal-align-center', center);
  b.toggle('horizontal-align-left', !center);
  b.toggle('vertical-align-middle', center);
  b.toggle('vertical-align-bottom', !center);
  // RNPN's colourful cover shadow (St, B@332692): a blurred copy of the cover under it
  let st = document.getElementById('bncm-cover-shadow');
  if (!st) { st = document.createElement('style'); st.id = 'bncm-cover-shadow'; document.head.append(st); }
  const src = state.cover?.cover;
  st.textContent = s.coverShadow === 'colorful' && src ? `
    .n-single .cdwrap::before { content: ""; position: absolute; inset: 0; background: url("${src}") center / cover;
      filter: saturate(1.3) brightness(1.2) blur(25px); opacity: .6; border-radius: 16px;
      transform: ${s.coverShape === 'round' ? 'none' : 'translateY(4%)'}; }
    .n-single .cdimg { box-shadow: none !important; }` : '';
  layoutSide();
}

// --- progress ------------------------------------------------------------------------------------
const fmt = (sec) => {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

function setProgressUi(pos) {
  const d = state.track?.duration || 0;
  const max = Math.max(d, pos, 1);
  els.thumb.style.width = `${(Math.min(pos, max) / max) * 100}%`;
  const tips = els.tips.children;
  tips[0].textContent = fmt(pos);
  tips[tips.length - 1].textContent = `-${fmt(Math.max(d - pos, 0))}`;
}

// The bar moves in steps, as in RNPN (one per progress event): four a second while playing, a
// fraction of a pixel each, never per frame.
function scheduleProgress() {
  clearTimeout(progressTimer);
  if (dragging || !state.window.visible) return;
  setProgressUi(now() / 1000);
  if (state.playing) progressTimer = setTimeout(scheduleProgress, 250);
}

function bindSlider(slider, commit, preview) {
  const ratio = (x) => {
    const r = slider.querySelector('.inner').getBoundingClientRect();
    return Math.max(0, Math.min(1, (x - r.left) / r.width));
  };
  slider.addEventListener('pointerdown', (e) => {
    dragging = true;
    slider.setPointerCapture(e.pointerId);
    slider.classList.add('dragging');
    preview(ratio(e.clientX));
  });
  slider.addEventListener('pointermove', (e) => { if (dragging && slider.hasPointerCapture(e.pointerId)) preview(ratio(e.clientX)); });
  const end = (e) => {
    if (!slider.hasPointerCapture(e.pointerId)) return;
    slider.releasePointerCapture(e.pointerId);
    slider.classList.remove('dragging');
    dragging = false;
    commit(ratio(e.clientX));
    scheduleProgress();
  };
  slider.addEventListener('pointerup', end);
  slider.addEventListener('pointercancel', end);
}

// --- buttons ---------------------------------------------------------------------------------
function renderPlaying(p) {
  els.play.innerHTML = p ? ICONS.pause : ICONS.play;
  els.play.setAttribute('aria-label', p ? 'Pause' : 'Play');
  document.body.classList.toggle('bncm-cover-paused', !p);
  scheduleProgress();
}

function renderLiked(v) {
  els.fav.classList.toggle('is-active', !!v);
  els.fav.innerHTML = v ? ICONS.heartActive : ICONS.heart;
  els.fav.title = v ? 'Unlike song' : 'Like song';
  els.fav.setAttribute('aria-label', els.fav.title);
}

const MODE = {
  order: ['modeOrder', 'Order'], repeat: ['modeRepeat', 'Repeat'], ai: ['modeAi', 'Heartbeat'],
  random: ['modeRandom', 'Shuffle'], one: ['modeOne', 'Repeat One'],
};
function renderMode(m) {
  const [icon, label] = MODE[m] || MODE.one;
  els.mode.innerHTML = ICONS[icon];
  els.mode.title = label;
  els.mode.setAttribute('aria-label', `Playback mode: ${label}`);
}

function addDislike(collapse) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'am-music-track-btn bncm-rnp-dislike';
  btn.title = '减少推荐';
  btn.setAttribute('aria-label', '减少推荐');
  // NCM's dislike opens a modal inside its own window, which this one covers
  btn.addEventListener('click', (e) => { e.stopPropagation(); send('dislike'); collapse(); });
  els.controls.append(btn);
  watch('dislikeIcon', (svg) => { btn.innerHTML = svg || ''; });
}
