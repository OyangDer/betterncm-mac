/*
 * accent.js -- RefinedNowPlayingNext 3.0.2 accent palette, reproduced for B.
 *
 * Port of RNPN main.js `wg` (byte offset ~680465) + `hg` (~680135) + the settings hook for
 * `#accent-color-variant` (~736322) + the CSS fallbacks in RNPN's CSS module (C11 / cmod8).
 * Uses ../vendor/mcu-bundle.js (@importantimport/material-color-utilities@0.2.1-alpha.0, Apache-2.0).
 *
 * Works in a browser (ES module) and in node >= 18 (no DOM needed except samplePixels()).
 *
 * API
 *   samplePixels(img[, canvas])         -> number[1024] ARGB, exactly RNPN's code. Exact only when run
 *                                          in Chromium (NCM's page); WebKit's drawImage differs a lot.
 *   samplePixelsChromium(rgba, w, h)    -> number[1024] ARGB: Skia's mipmap+bilinear downscale emulated
 *                                          from full-size decoded RGBA (bit-exact given libjpeg-turbo bytes).
 *   argbFromRgbaBytes(rgbaBytes)        -> number[] ARGB from ImageData.data (RGBA bytes).
 *   computeAccent(pixels, variant[, {seed|random}])
 *                                       -> { grey, source, variant, enabled, rgb, vars, entries }
 *   computeAccentModal(pixels, variant[, runs=16]) -> deterministic most-likely RNPN outcome.
 *        variant = the RNPN setting value: "off" | "primary" | "secondary" | "tertiary"
 *        (any other string is treated like window.accentColorVariant would be; see notes).
 *        vars    = { "--rnp-accent-color-dark": "rgb(r, g, b)", "--rnp-accent-color-dark-rgb": "r, g, b", ... }
 *                  the 20 body inline properties RNPN writes, in RNPN's write order.
 *        enabled = false for "off" (RNPN then removes body.enable-accent-color, so the CSS
 *                  fallbacks in OFF_FALLBACK apply; the -dark/-light vars are still written).
 *   resolveTheme(result, mode)          -> the effective --rnp-accent-color[-x] values RNPN's CSS
 *        produces on `body > *` for mode "dark" | "light" (includes overlay/contrast/drop-shadow
 *        and the "off" fallbacks). Handy if B uses the generic names.
 *   applyAccent(el, result)             -> writes result.vars onto el.style (like RNPN on body).
 *   setRandom(fn)                       -> re-exported; WSMeans RNG (default Math.random, as RNPN).
 */
import { QuantizerCelebi, Score, themeFromSourceColor, Hct, setRandom } from '../vendor/mcu-bundle.js';

export { setRandom };

export const SAMPLE_SIZE = 32; // RNPN vg
export const VARIANTS = ['off', 'primary', 'secondary', 'tertiary']; // RNPN settings buttons

// RNPN `P`: argb -> [r, g, b]   (works for signed and unsigned ints, and undefined -> 0,0,0)
const rgbOf = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
// RNPN `O`: r,g,b -> argb (signed, like RNPN)
const argbOf = (r, g, b) => (255 << 24) | (r << 16) | (g << 8) | b;

// RNPN grey fallback (wg, grey branch). Order = RNPN write order.
const GREY = [
  ['rnp-accent-color-dark', 150],
  ['rnp-accent-color-on-primary-dark', 10],
  ['rnp-accent-color-shade-1-dark', 210],
  ['rnp-accent-color-shade-2-dark', 255],
  ['rnp-accent-color-bg-dark', 50],
  ['rnp-accent-color-light', 120],
  ['rnp-accent-color-on-primary-light', 250],
  ['rnp-accent-color-shade-1-light', 40],
  ['rnp-accent-color-shade-2-light', 20],
  ['rnp-accent-color-bg-light', 190],
];

/** ImageData.data (RGBA bytes) -> ARGB ints, identical to RNPN's loop. */
export function argbFromRgbaBytes(r) {
  const n = r.length >> 2;
  const o = new Array(n);
  for (let i = 0, a = 0; i < r.length; i += 4, a++) {
    o[a] = ((r[i + 3] << 24) >>> 0 | (r[i] << 16) >>> 0 | (r[i + 1] << 8) >>> 0 | r[i + 2]) >>> 0;
  }
  return o;
}

let _canvas = null;
/** Browser only. Same canvas recipe as RNPN (2d, willReadFrequently, clearRect, default smoothing). */
export function samplePixels(img, canvas) {
  const c = canvas || _canvas || (_canvas = document.createElement('canvas'));
  c.width = SAMPLE_SIZE; c.height = SAMPLE_SIZE; // RNPN sets these once; re-setting to same value is harmless
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  return argbFromRgbaBytes(ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
}

/*
 * Chromium/Skia emulation of RNPN's `drawImage(img, 0,0,nw,nh, 0,0,32,32)` + getImageData on a
 * willReadFrequently (CPU raster) canvas, from full-resolution decoded RGBA bytes.
 * WebKit's own drawImage gives very different 32x32 samples (it point-samples), so B must not call
 * samplePixels() in WKWebView if it wants RNPN's colours; use this on decoded bytes instead, or get
 * the 1024 ints from NCM's page.
 * Empirically bit-exact vs NCM 3.1.14 (CEF/Chromium) on 16/16 covers (800x800 and 640x640, 4:4:4 and
 * 4:2:0 JPEG) when the bytes come from libjpeg-turbo (e.g. Pillow). Model:
 *   1. mip chain: each level = floor(src/2) per axis, built with Skia's SkMipmap box filters with
 *      truncating division (2x2 -> >>2; odd axis uses 1-2-1 taps, see downsample()).
 *   2. level = floor(log2(srcSize / 32)) (largest axis ratio; non-square is unverified).
 *   3. bilinear at pixel centres from that level, fractional weights truncated to 1/16 (Skia lowp),
 *      edges clamped, result truncated.
 * Opaque images only (alpha would need premultiplication; NCM covers are JPEG).
 */
function mipDown(src) {
  const { w, h, d } = src;
  const W = Math.max(1, w >> 1), H = Math.max(1, h >> 1);
  const o = new Uint8ClampedArray(W * H * 4);
  // taps per axis: even -> [1,1] (or [1] when size 1), odd (>1) -> [1,2,1]; SkMipmap downsample_{1,2,3}_{1,2,3}
  const tx = w === 1 ? [1] : (w & 1 ? [1, 2, 1] : [1, 1]);
  const ty = h === 1 ? [1] : (h & 1 ? [1, 2, 1] : [1, 1]);
  const sx = tx.reduce((a, b) => a + b), sy = ty.reduce((a, b) => a + b);
  const shift = Math.log2(sx * sy);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let k = 0; k < 4; k++) {
    let s = 0;
    for (let j = 0; j < ty.length; j++) for (let i = 0; i < tx.length; i++) {
      const X = Math.min(w - 1, 2 * x + i), Y = Math.min(h - 1, 2 * y + j);
      s += tx[i] * ty[j] * d[(Y * w + X) * 4 + k];
    }
    o[(y * W + x) * 4 + k] = s >> shift;
  }
  return { w: W, h: H, d: o };
}

/**
 * @param {Uint8Array|Uint8ClampedArray|number[]} rgba full-size decoded pixels, row-major RGBA
 * @param {number} w natural width  @param {number} h natural height
 * @returns {number[]} 1024 ARGB ints, what RNPN's canvas yields in NCM (Chromium)
 */
export function samplePixelsChromium(rgba, w, h) {
  const N = SAMPLE_SIZE;
  let img = { w, h, d: rgba };
  const ratio = Math.max(w / N, h / N);
  const level = ratio > 1 ? Math.floor(Math.log2(ratio)) : 0;
  for (let l = 0; l < level && (img.w > 1 || img.h > 1); l++) img = mipDown(img);
  const { w: lw, h: lh, d } = img, sx = lw / N, sy = lh / N;
  const at = (x, y, k) => d[(Math.min(lh - 1, Math.max(0, y)) * lw + Math.min(lw - 1, Math.max(0, x))) * 4 + k];
  const out = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const X = (x + 0.5) * sx - 0.5, Y = (y + 0.5) * sy - 0.5;
    const x0 = Math.floor(X), y0 = Math.floor(Y);
    const fx = Math.floor((X - x0) * 16), fy = Math.floor((Y - y0) * 16); // 4-bit weights
    for (let k = 0; k < 4; k++) {
      const v = at(x0, y0, k) * (16 - fx) * (16 - fy) + at(x0 + 1, y0, k) * fx * (16 - fy)
              + at(x0, y0 + 1, k) * (16 - fx) * fy + at(x0 + 1, y0 + 1, k) * fx * fy;
      out[(y * N + x) * 4 + k] = v >> 8;
    }
  }
  return argbFromRgbaBytes(out);
}

/** Quantize + sort exactly like RNPN. Exposed for debugging. Returns [[argb, count], ...] desc. */
export function rankedColors(pixels, random) {
  if (random) setRandom(random);
  let l;
  try { l = QuantizerCelebi.quantize(pixels, 128); } finally { if (random) setRandom(null); }
  return Array.from(l).sort((e, t) => t[1] - e[1]); // stable sort (V8 / JSC both stable)
}

/**
 * RNPN wg() minus the canvas step.
 * @param {number[]} pixels 1024 ARGB ints (any length works)
 * @param {string} variant RNPN setting value; "off" -> computed as "primary", enabled=false
 * @param {{seed?: number, random?: () => number}} [opts] RNG for WSMeans. Default Math.random (= RNPN,
 *        non-deterministic). A fixed seed makes B stable per cover (one of RNPN's possible outcomes).
 */
export function computeAccent(pixels, variant = 'primary', opts = {}) {
  const enabled = variant !== 'off';
  // settings hook: window.accentColorVariant = "off"==e ? "primary" : e ; wg: u = accentColorVariant ?? "primary"
  const u = variant == null || variant === 'off' ? 'primary' : variant;
  const rnd = opts.random || (opts.seed != null ? mulberry32(opts.seed) : null);
  const s = rankedColors(pixels, rnd);
  const entries = []; // [name, argb] in RNPN write order
  let grey = false, source = null;

  if (s.slice(0, 5).map((e) => rgbOf(e[0])).every((e) => Math.max(...e) - Math.min(...e) < 5)) {
    grey = true;
    for (const [name, v] of GREY) entries.push([name, argbOf(v, v, v)]);
  } else {
    source = Score.score(new Map(s.slice(0, 50)))[0];
    const c = themeFromSourceColor(source);
    const P = c.palettes[u]; // primary=a1, secondary=a2, tertiary=a3 (also neutral/neutralVariant/error)
    if (!P) throw new TypeError(`accent variant "${u}" has no palette (RNPN would throw here too)`);
    const S = c.palettes.secondary; // bg always from a2, regardless of variant
    const tone = (p, t) => Hct.from(p.hue, p.chroma, t).toInt(); // RNPN uses Hct.from, not TonalPalette.tone (same value)
    entries.push(
      ['rnp-accent-color-dark', c.schemes.dark[u]],            // primary/secondary/tertiary -> a*.tone(80)
      ['rnp-accent-color-on-primary-dark', tone(P, 20)],
      ['rnp-accent-color-shade-1-dark', tone(P, 80)],
      ['rnp-accent-color-shade-2-dark', tone(P, 90)],
      ['rnp-accent-color-bg-dark', tone(S, 20)],
      ['rnp-accent-color-light', c.schemes.light.onPrimaryContainer], // a1.tone(10) for every variant
      ['rnp-accent-color-on-primary-light', tone(P, 100)],
      ['rnp-accent-color-shade-1-light', tone(P, 25)],
      ['rnp-accent-color-shade-2-light', tone(P, 15)],
      ['rnp-accent-color-bg-light', tone(S, 90)],
    );
  }

  const vars = {}, rgb = {};
  for (const [name, argb] of entries) {
    const [r, g, b] = rgbOf(argb); // undefined (e.g. schemes.dark.neutral) -> 0,0,0 exactly like RNPN
    rgb[name] = [r, g, b];
    vars[`--${name}`] = `rgb(${r}, ${g}, ${b})`;
    vars[`--${name}-rgb`] = `${r}, ${g}, ${b}`;
  }
  return { grey, source: source == null ? null : source >>> 0, variant: u, enabled, rgb, vars, entries };
}

/** Small deterministic PRNG for opts.seed. */
export function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Most likely RNPN outcome: runs computeAccent `runs` times with seeds 1..runs and returns the
 * result whose 20 vars occur most often (ties -> lowest seed). Deterministic. ~6 ms per run
 * (M-series, node), so 16 runs ~ 0.1 s once per song.
 */
export function computeAccentModal(pixels, variant = 'primary', runs = 16) {
  const seen = new Map();
  let best = null, bestN = 0;
  for (let s = 1; s <= runs; s++) {
    const r = computeAccent(pixels, variant, { seed: s });
    const k = JSON.stringify(r.vars);
    const e = seen.get(k) || { r, n: 0 };
    e.n++; seen.set(k, e);
    if (e.n > bestN) { best = e.r; bestN = e.n; }
  }
  return Object.assign(best, { modalShare: bestN / runs, distinctOutcomes: seen.size });
}

// CSS fallbacks applied when body lacks .enable-accent-color ("off") or has no --rnp-accent-color* inline
// style yet (cmod8). bg is NOT overridden there, so it keeps the computed -bg-<mode> value.
export const OFF_FALLBACK = {
  dark: { '': [170, 170, 170], 'on-primary': [238, 238, 238], 'shade-1': [238, 238, 238], 'shade-2': [255, 255, 255] },
  light: { '': [50, 50, 50], 'on-primary': [0, 0, 0], 'shade-1': [35, 35, 35], 'shade-2': [15, 15, 15] },
};
const EXTRA = {
  dark: { '--rnp-accent-color-overlay': '#000', '--rnp-accent-color-contrast': '#fff', '--rnp-drop-shadow': 'drop-shadow(0px 4px 5px rgba(0, 0, 0, 0.3))' },
  light: { '--rnp-accent-color-overlay': '#fff', '--rnp-accent-color-contrast': '#000', '--rnp-drop-shadow': 'drop-shadow(0px 4px 5px rgba(0, 0, 0, 0.25))' },
};

/**
 * Effective generic variables on `body > *` (C11 mapping + cmod8 fallbacks).
 * @param result computeAccent() result, or null for "nothing computed yet"
 * @param mode "dark" | "light"
 */
export function resolveTheme(result, mode = 'dark') {
  const out = {};
  for (const role of ['', 'on-primary', 'shade-1', 'shade-2', 'bg']) {
    const base = role ? `rnp-accent-color-${role}` : 'rnp-accent-color';
    let v = result ? result.rgb[`${base}-${mode}`] : undefined;
    const fb = OFF_FALLBACK[mode][role];
    if (fb && (!result || !result.enabled)) v = fb;
    if (!v) continue; // bg with nothing computed: RNPN leaves it unset
    out[`--${base}`] = `rgb(${v[0]}, ${v[1]}, ${v[2]})`;
    out[`--${base}-rgb`] = `${v[0]}, ${v[1]}, ${v[2]}`;
  }
  return Object.assign(out, EXTRA[mode]);
}

/** Write the 20 RNPN properties onto an element (RNPN writes them on document.body). */
export function applyAccent(el, result) {
  for (const k in result.vars) el.style.setProperty(k, result.vars[k]);
}
