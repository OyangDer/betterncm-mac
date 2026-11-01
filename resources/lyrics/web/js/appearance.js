// How the page looks as a whole: colour scheme, accent, text effect, background, and the window's
// states (opening, full screen). RNPN keeps these as body classes; so do we.
import { log, on } from './bus.js';
import { requestCover, coverUrl } from './side.js';
import { applyAccentFor } from './accent.js';
import { state, set, watch } from './state.js';

const body = () => document.body.classList;

// --- colour scheme ------------------------------------------------------------------------------
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
// Returns whether the background was rendered again.
function applyScheme() {
  // the settings arrive from the host after the page has started: until then, the default
  const mode = state.settings?.scheme || 'auto';
  const b = body();
  const sys = darkQuery.matches ? 'dark' : 'light';
  b.toggle('rnp-auto', mode === 'auto');
  b.toggle('rnp-dark', mode === 'dark');
  b.toggle('rnp-light', mode === 'light');
  b.toggle('rnp-system-dark', sys === 'dark');
  b.toggle('rnp-system-light', sys === 'light');
  const scheme = mode === 'auto' ? sys : mode;
  if (scheme === state.scheme) return false;
  set('scheme', scheme);
  rerenderBackground();
  return true;
}
darkQuery.addEventListener('change', applyScheme);

// The host's background carries the scheme's overlay, so it is rendered again.
function rerenderBackground() {
  requestCover();
}

// --- settings as classes ----------------------------------------------------------------------------
function applyLook(s, old) {
  if (!s) return;
  const b = body();
  b.toggle('rnp-shadow', s.textEffect === 'shadow');
  b.toggle('rnp-text-glow', s.textEffect === 'glow');
  for (const v of ['primary', 'secondary', 'tertiary']) b.toggle(`accent-color-${v}`, s.accent === v);
  b.toggle('enable-accent-color', s.accent !== 'off');
  b.toggle('hide-player-controls', !s.showControls);
  b.toggle('rnp-bg-blur', s.bgType === 'blur');
  b.toggle('rnp-bg-gradient', s.bgType === 'gradient');
  b.toggle('rnp-bg-solid', s.bgType === 'solid');
  b.toggle('gradient-bg-dynamic', !!s.gradientDynamic);
  b.toggle('rnp-custom-font', s.font === 'custom' && s.fontList.length > 0);
  const custom = s.font === 'custom' && s.fontList.length ? s.fontList.map((f) => `"${f.replace(/"/g, '')}"`) : null;
  document.body.style.fontFamily = custom ? [...custom, '"PingFang SC"', 'arial', 'sans-serif'].join(', ') : '';
  for (const [v, face] of [['--bncm-font-semibold', 'Semibold'], ['--bncm-font-medium', 'Medium']]) {
    // a custom "PingFang SC" (RNPN's lists often have it) would take WebKit's wider bold instance (app.css)
    const named = custom?.map((f) => (f === '"PingFang SC"' ? `"PingFang SC ${face}"` : f));
    if (named) document.body.style.setProperty(v, [...named, `"PingFang SC ${face}"`, '"PingFang SC"', 'arial', 'sans-serif'].join(', '));
    else document.body.style.removeProperty(v);
  }
  document.body.style.setProperty('--bg-dim-for-gradient-bg', String((s.gradientDim ?? 45) / 100));
  if (!applyScheme() && old && (s.bgBlur !== old.bgBlur || s.bgDim !== old.bgDim)) rerenderBackground();
  applyBackground();
  applyAccent();
}

async function applyAccent() {
  const url = coverUrl(state.track?.cover);
  if (!state.track || !url) return;
  try {
    await applyAccentFor(url, state.settings?.accent || 'primary');
  } catch (e) {
    log('accent failed:', String(e?.message || e));
  }
}

// --- background ------------------------------------------------------------------------------------
// 模糊 is the host's pre-blurred cover (side.js). 纯色 is RNPN's solid layer as it is. 渐变 is RNPN's
// gradient (vt): six colours of the cover, linear-gradient(-45deg) on a layer four times the
// window's size, of which the window shows the middle, or, 动态, a quarter panning around the edge
// over 120 s by animating background-position, which repaints the whole window every frame. Here
// the same gradient is drawn once into a small image, shown at that size, and panned with a
// transform: the compositor only moves (and scales) the image.
const els = {};
function bgLayer(cls) {
  const bg = document.querySelector('#rnp-view .rnp-bg');
  if (!bg) return null;
  let el = bg.querySelector(`:scope > .${cls}`);
  if (!el) { el = document.createElement('div'); el.className = cls; bg.append(el); }
  return el;
}

function applyBackground() {
  const type = state.settings?.bgType;
  if (type === 'solid') bgLayer('rnp-background-solid');
  if (type === 'gradient') {
    if (!els.gradient) {
      els.gradient = bgLayer('rnp-background-gradient');
      if (!els.gradient) return;
      els.gradientImg = document.createElement('img');
      els.gradientImg.alt = '';
      els.gradientImg.decoding = 'async';
      els.gradient.append(els.gradientImg);
    }
    updateGradient();
  }
  applyMotion();
}

// RNPN's starting gradient, shown until the cover's colours are known or when they cannot be found
const DEFAULT_STOPS = [[0x66, 0x66, 0x66], [0xff, 0xff, 0xff]];
const paletteCache = new Map(); // cover asset URL -> stops
let gradientKey = '';
let gradientSeq = 0;
async function updateGradient() {
  if (!els.gradientImg) return;
  const src = state.cover?.cover || '';
  const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
  const key = `${src}|${(w / h).toFixed(3)}`;
  if (key === gradientKey) return;
  gradientKey = key;
  const seq = ++gradientSeq;
  let stops = paletteCache.get(src);
  if (!stops && src) {
    try {
      stops = gradientStops(paletteOf(await loadPixels(src)));
    } catch (e) {
      log('gradient palette failed:', String(e?.message || e));
      stops = DEFAULT_STOPS;
    }
    paletteCache.set(src, stops);
    if (paletteCache.size > 20) paletteCache.delete(paletteCache.keys().next().value);
  }
  if (seq !== gradientSeq) return;
  const url = await drawGradient(stops || DEFAULT_STOPS, w, h);
  if (seq !== gradientSeq) { URL.revokeObjectURL(url); return; }
  const old = els.gradientImg.src;
  els.gradientImg.src = url;
  if (old.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(old), 1000);
}

export function loadPixels(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, c.width, c.height));
    };
    img.onerror = () => reject(new Error(`cannot load ${src}`));
    img.src = src;
  });
}

// linear-gradient(-45deg, ...) over a box the shape of the layer (4w x 4h), at most 512 px wide:
// the gradient is linear between its stops, so the scaled-up image is the same gradient.
function drawGradient(stops, w, h) {
  const k = 512 / Math.max(w, h);
  const cw = Math.max(2, Math.round(w * k)), ch = Math.max(2, Math.round(h * k));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d');
  // CSS: the gradient line runs through the centre at the angle, as long as the box's projection on it
  const a = (-45 * Math.PI) / 180;
  const dx = Math.sin(a), dy = -Math.cos(a);
  const half = (Math.abs(cw * dx) + Math.abs(ch * dy)) / 2;
  const g = ctx.createLinearGradient(cw / 2 - dx * half, ch / 2 - dy * half, cw / 2 + dx * half, ch / 2 + dy * half);
  stops.forEach(([r, gg, b], i) => g.addColorStop(i / (stops.length - 1), `rgb(${r}, ${gg}, ${b})`));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cw, ch);
  return new Promise((resolve) => c.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : c.toDataURL()), 'image/png'));
}

// The pan runs only while it can be seen and the music plays; paused, it keeps its place.
function applyMotion() {
  const moving = state.settings?.bgType === 'gradient' && !!state.settings?.gradientDynamic
    && state.window.visible && state.playing;
  body().toggle('bncm-bg-paused', !moving);
  // the title's marquee (app.css) runs whatever the background
  body().toggle('bncm-motion-paused', !state.playing || !state.window.visible);
}

let resizeTimer = 0;
window.addEventListener('resize', () => {
  if (state.settings?.bgType !== 'gradient') return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(updateGradient, 250);
});

// --- RNPN's palette for the gradient: color-thief's getPalette (MMCQ, 10 colours, every 10th pixel)
// and its gradient builder M, as RNPN 3.0.2 bundles them (main.js @292794 and the color-thief
// port before `st`). ----------------------------------------------------------------------------------
export function paletteOf(imageData) {
  const pick = (ignoreWhite, alphaThreshold) => {
    const d = imageData.data, n = imageData.width * imageData.height, out = [];
    for (let i = 0; i < n; i += 10) {
      const o = i * 4, r = d[o], g = d[o + 1], b = d[o + 2], a = d[o + 3];
      if (a !== undefined && a < alphaThreshold) continue;
      if (ignoreWhite && r > 250 && g > 250 && b > 250) continue;
      out.push([r, g, b]);
    }
    return out;
  };
  let px = pick(true, 125);
  if (!px.length) px = pick(false, 125);
  if (!px.length) px = pick(false, 0);
  return quantize(px, 10) || null;
}

const idx = (r, g, b) => (r << 10) + (g << 5) + b;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function pqueue(sorter) {
  const items = [];
  let sorted = false;
  const sort = () => { items.sort(sorter); sorted = true; };
  return {
    push(o) { items.push(o); sorted = false; },
    pop() { if (!sorted) sort(); return items.pop(); },
    size: () => items.length,
    map: (fn) => items.map(fn),
  };
}

class VBox {
  constructor(r1, r2, g1, g2, b1, b2, histo) { Object.assign(this, { r1, r2, g1, g2, b1, b2, histo }); }
  volume() {
    if (this._volume === undefined) this._volume = (this.r2 - this.r1 + 1) * (this.g2 - this.g1 + 1) * (this.b2 - this.b1 + 1);
    return this._volume;
  }
  count() {
    if (this._count === undefined) {
      let n = 0;
      for (let r = this.r1; r <= this.r2; r++) for (let g = this.g1; g <= this.g2; g++) for (let b = this.b1; b <= this.b2; b++) n += this.histo[idx(r, g, b)] || 0;
      this._count = n;
    }
    return this._count;
  }
  copy() { return new VBox(this.r1, this.r2, this.g1, this.g2, this.b1, this.b2, this.histo); }
  avg() {
    if (this._avg) return this._avg;
    if (this.r1 === this.r2 && this.g1 === this.g2 && this.b1 === this.b2) {
      this._avg = [this.r1 << 3, this.g1 << 3, this.b1 << 3];
      return this._avg;
    }
    let total = 0, rs = 0, gs = 0, bs = 0;
    for (let r = this.r1; r <= this.r2; r++) for (let g = this.g1; g <= this.g2; g++) for (let b = this.b1; b <= this.b2; b++) {
      const h = this.histo[idx(r, g, b)] || 0;
      total += h; rs += h * (r + 0.5) * 8; gs += h * (g + 0.5) * 8; bs += h * (b + 0.5) * 8;
    }
    this._avg = total ? [~~(rs / total), ~~(gs / total), ~~(bs / total)]
      : [~~((8 * (this.r1 + this.r2 + 1)) / 2), ~~((8 * (this.g1 + this.g2 + 1)) / 2), ~~((8 * (this.b1 + this.b2 + 1)) / 2)];
    return this._avg;
  }
}

function medianCut(histo, box) {
  if (!box.count()) return undefined;
  const rw = box.r2 - box.r1 + 1, gw = box.g2 - box.g1 + 1, bw = box.b2 - box.b1 + 1;
  const maxw = Math.max(rw, gw, bw);
  if (box.count() === 1) return [box.copy()];
  const dim = maxw === rw ? 'r' : maxw === gw ? 'g' : 'b';
  const [o1, o2] = dim === 'r' ? ['g', 'b'] : dim === 'g' ? ['r', 'b'] : ['r', 'g'];
  const at = (i, j, k) => (dim === 'r' ? idx(i, j, k) : dim === 'g' ? idx(j, i, k) : idx(j, k, i));
  let total = 0;
  const partial = [], lookahead = [];
  for (let i = box[`${dim}1`]; i <= box[`${dim}2`]; i++) {
    let sum = 0;
    for (let j = box[`${o1}1`]; j <= box[`${o1}2`]; j++) for (let k = box[`${o2}1`]; k <= box[`${o2}2`]; k++) sum += histo[at(i, j, k)] || 0;
    total += sum;
    partial[i] = total;
  }
  partial.forEach((d, i) => { lookahead[i] = total - d; });
  const d1 = `${dim}1`, d2 = `${dim}2`;
  for (let i = box[d1]; i <= box[d2]; i++) {
    if (partial[i] > total / 2) {
      const a = box.copy(), b = box.copy();
      const left = i - box[d1], right = box[d2] - i;
      let cut = left <= right ? Math.min(box[d2] - 1, ~~(i + right / 2)) : Math.max(box[d1], ~~(i - 1 - left / 2));
      while (!partial[cut]) cut++;
      let count2 = lookahead[cut];
      while (!count2 && partial[cut - 1]) count2 = lookahead[--cut];
      a[d2] = cut;
      b[d1] = a[d2] + 1;
      return [a, b];
    }
  }
  return undefined;
}

function quantize(pixels, maxColors) {
  if (!pixels.length) return null;
  const seen = new Set(), unique = [];
  for (const p of pixels) { const k = p.join(','); if (!seen.has(k)) { seen.add(k); unique.push(p); } }
  if (unique.length <= maxColors) return unique;
  const histo = new Array(32768);
  for (const p of pixels) { const i = idx(p[0] >> 3, p[1] >> 3, p[2] >> 3); histo[i] = (histo[i] || 0) + 1; }
  // color-thief's bounds: else-if, so the first pixel only lowers the minimums
  let rmin = 1e6, rmax = 0, gmin = 1e6, gmax = 0, bmin = 1e6, bmax = 0;
  for (const p of pixels) {
    const r = p[0] >> 3, g = p[1] >> 3, b = p[2] >> 3;
    if (r < rmin) rmin = r; else if (r > rmax) rmax = r;
    if (g < gmin) gmin = g; else if (g > gmax) gmax = g;
    if (b < bmin) bmin = b; else if (b > bmax) bmax = b;
  }
  const first = new VBox(rmin, rmax, gmin, gmax, bmin, bmax, histo);
  const iterate = (q, target) => {
    let n = q.size(), i = 0;
    while (i < 1000) {
      if (n >= target) return;
      if (i++ > 1000) return;
      const box = q.pop();
      if (box.count()) {
        const cut = medianCut(histo, box);
        if (!cut || !cut[0]) return;
        q.push(cut[0]);
        if (cut[1]) { q.push(cut[1]); n++; }
      } else { q.push(box); i++; }
    }
  };
  const byCount = pqueue((a, b) => cmp(a.count(), b.count()));
  byCount.push(first);
  iterate(byCount, 0.75 * maxColors);
  const byProduct = pqueue((a, b) => cmp(a.count() * a.volume(), b.count() * b.volume()));
  while (byCount.size()) byProduct.push(byCount.pop());
  iterate(byProduct, maxColors);
  const out = [];
  while (byProduct.size()) out.push(byProduct.pop().avg());
  return out;
}

const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) => 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255);
function saturation([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return 0;
  const d = max - min;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
}
function lab(rgb) {
  const [r, g, b] = rgb.map((c) => lin(c / 255) * 100);
  const x = 0.4124 * r + 0.3576 * g + 0.1805 * b, y = 0.2126 * r + 0.7152 * g + 0.0722 * b, z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  const f = (t) => (t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116);
  return [116 * f(y / 100) - 16, 500 * (f(x / 95.047) - f(y / 100)), 200 * (f(y / 100) - f(z / 108.883))];
}
const deltaE = (a, b) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };

// M: the 8 middle colours by luminance, the 6 most saturated of them, ordered (almost: see the end)
// so that the largest step between neighbours is as small as possible. RNPN throws (and keeps its starting gradient)
// when the cover has fewer than six colours.
export function gradientStops(palette) {
  if (!palette) return DEFAULT_STOPS;
  let e = [...palette].sort((a, b) => luminance(a) - luminance(b));
  e = e.slice(e.length / 2 - 4, e.length / 2 + 4).sort((a, b) => saturation(b) - saturation(a)).slice(0, 6);
  if (e.length < 6) return DEFAULT_STOPS;
  const dist = Array.from({ length: 6 }, () => new Array(6).fill(0));
  for (let r = 0; r < 6; r++) for (let o = r + 1; o < 6; o++) { dist[r][o] = deltaE(e[r], e[o]); dist[o][r] = dist[r][o]; }
  const used = new Array(6).fill(false);
  let best = 1e7, order = [];
  const walk = (depth, path, worst) => {
    if (depth === 6) { if (worst < best) { best = worst; order = path; } return; }
    for (let o = 0; o < 6; o++) {
      if (used[o]) continue;
      used[o] = true;
      walk(depth + 1, path.concat(o), Math.max(worst, dist[path[depth - 1]][o]));
      used[o] = false;
    }
  };
  for (let c = 0; c < 6; c++) { used[c] = true; walk(1, [c], -1); used[c] = false; }
  // RNPN reads the order through itself (for (f of l) d.push(e[l[f]])); kept, as that is its look
  return order.map((i) => e[order[i]]);
}

// --- opening and full screen -------------------------------------------------------------------------
// RNPN's page comes in when NCM opens its now-playing page: .g-single fades in while its content
// rises from half the page (now-playing-page / -inner, .5 s), and the cover, the info and the
// lyrics follow with their own transitions. The window here is hidden, not destroyed, so the page
// is put back to that starting point when it hides and released when it shows again.
let closed = false;
function setClosed(v) {
  if (v === closed) return;
  closed = v;
  body().toggle('bncm-closed', v);
  // the starting point must be computed before it is left, or nothing moves
  if (v) document.querySelector('#rnp-view .g-single')?.getBoundingClientRect();
}
// whatever else happens, the page must not stay invisible once it can be seen
const reveal = () => setClosed(false);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reveal(); });
document.addEventListener('pointermove', reveal, { passive: true });
on('open', reveal);

// Full screen: RNPN's rnp-full-screen, which hides the pointer once it rests (rnp-idle).
let idleTimer = 0;
function wake() {
  body().remove('rnp-idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => body().add('rnp-idle'), 1500);
}
function applyFullscreen(on) {
  body().toggle('rnp-full-screen', on);
  if (on) { document.addEventListener('mousemove', wake, { passive: true }); wake(); return; }
  document.removeEventListener('mousemove', wake);
  clearTimeout(idleTimer);
  body().remove('rnp-idle');
}

function onWindow(w, old) {
  if (!old || w.fullscreen !== old.fullscreen) applyFullscreen(!!w.fullscreen);
  if (old && old.visible && !w.visible) setClosed(true);
  else if (w.visible) setClosed(false);
  applyMotion();
}

// --- wiring ----------------------------------------------------------------------------------------
watch('settings', applyLook);
watch('track', (t, old) => { if (t && (!old || t.cover !== old.cover)) applyAccent(); });
watch('cover', () => { if (state.settings?.bgType === 'gradient') updateGradient(); });
watch('playing', applyMotion);
watch('window', onWindow);

/** After the template is in the page. */
export function mountAppearance() {
  if (state.settings) applyLook(state.settings);
  else applyScheme();
}
