// The lyric column: RNPN 3.0.2's layout, highlight and motion (its lyrics.js component), drawn with
// transform and opacity transitions only. JS runs when a line changes (plus a few times a second
// from progress messages), never per frame.
import { send } from './bus.js';
import { now, onClock, seeks } from './clock.js';
import { flags } from './parse.js';
import { state, watch } from './state.js';
import { update as updateSettings } from './settings.js';

const STAGGER_LEAD = 200; // lines start moving this long before their time (lyric-stagger)
const RETURN_MS = 2500; // after the last wheel event, back to the current line
const CJK = /[\p{Unified_Ideograph}぀-ゟ゠-ヿ]/u;

let box; // .rnp-lyrics
let col; // the lyric column
let switchCol;
let scrollbar;
let thumb;
let lines = []; // [{el, line, words: [{el, glow, ...}], dots}]
let heights = [];
let contrib = null; // {el, h}
let model = null; // {lyrics, flags, id}
let fontPx = 32;
let cur = -1; // current line (highlight)
let scrollLine = -1; // layout anchor
let prevScroll = -1;
let scrolling = false;
let scrollFocus = 0;
let returnTimer = 0;
let lineTimer = 0;
let lastSeeks = -1;
let shouldTransit = false;

const S = () => state.settings || {};

export function mountLyrics(column) {
  col = column;
  box = document.createElement('div');
  box.className = 'rnp-lyrics';
  col.append(box);

  switchCol = document.createElement('div');
  switchCol.className = 'rnp-lyrics-switch';
  switchCol.innerHTML = `<div class="rnp-lyrics-switch-btn-divider"></div>
    <button type="button" class="rnp-lyrics-switch-btn" data-k="showTranslation" title="翻译">译</button>
    <button type="button" class="rnp-lyrics-switch-btn" data-k="showRomaji" title="罗马音">音</button>
    <button type="button" class="rnp-lyrics-switch-btn" data-k="karaoke" title="逐字歌词">逐字</button>`;
  switchCol.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]');
    if (!b || b.classList.contains('unavailable')) return;
    updateSettings({ [b.dataset.k]: !S()[b.dataset.k] });
  });
  col.append(switchCol);

  scrollbar = document.createElement('div');
  scrollbar.className = 'rnp-lyrics-scrollbar';
  thumb = document.createElement('div');
  thumb.className = 'rnp-lyrics-scrollbar-thumb';
  scrollbar.append(thumb);
  col.append(scrollbar);
  bindScrollbar();

  box.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('mouseleave', () => { if (scrolling && state.playing) endScrolling(0); });
  box.addEventListener('click', onLineClick);

  new ResizeObserver(() => relayout(true)).observe(box);
  watch('lyrics', build);
  watch('settings', (s, old) => {
    applySettingClasses();
    const structural = !old || ['showTranslation', 'showRomaji', 'karaoke', 'karaokeAnim', 'glow', 'contributors'].some((k) => s[k] !== old[k]);
    const sized = !old || ['fontSize', 'translationEm', 'romajiEm', 'bold', 'translationWeight'].some((k) => s[k] !== old[k]);
    // the face is applied by appearance.js's watcher, which runs after this one: measure on the next frame
    const face = old && (s.font !== old.font || String(s.fontList) !== String(old.fontList));
    if (structural) build(state.lyrics);
    else if (sized || ['zoom', 'blur', 'fade', 'alignment'].some((k) => s[k] !== old[k])) relayout(true);
    if (face && !structural) requestAnimationFrame(() => { relayout(true); document.fonts.ready.then(() => relayout(true)); });
    // the offset moves the current line, not the layout; the clock is silent while paused
    if (!structural && s.offset !== old.offset) tick(true);
  });
  watch('window', (w, old) => {
    // hidden: nothing to schedule; shown again: catch up at once
    if (!w.visible) { clearTimeout(lineTimer); return; }
    if (old && !old.visible) { tick(true); return; }
    relayout(true);
  });
  watch('playing', () => onPlayState());
  onClock((kind) => {
    if (kind === 'state') return;
    tick(kind === 'jump');
  });
  applySettingClasses();
}

// --- settings that are classes or variables --------------------------------------------------
function applySettingClasses() {
  const s = S();
  const b = document.body.classList;
  b.toggle('original-lyric-bold', !!s.bold);
  b.toggle('bncm-tr-medium', s.translationWeight === 'medium');
  b.toggle('bncm-tr-semibold', s.translationWeight === 'semibold');
  b.toggle('rnp-karaoke-animation-float', s.karaokeAnim !== 'slide');
  b.toggle('rnp-karaoke-animation-slide', s.karaokeAnim === 'slide');
  for (const t of ['sharp', 'easeout', 'lazy', 'smooth']) b.toggle(`rnp-lyric-animation-timing-${t}`, s.timing === t);
  for (const c of ['show', 'hover', 'hide']) b.toggle(`rnp-lyric-contributors-${c}`, s.contributors === c);
  document.body.style.setProperty('--lyric-romaji-size-em', `${s.romajiEm ?? 0.6}em`);
  if (s.translationEm) document.body.style.setProperty('--lyric-translation-size-em', `${s.translationEm}em`);
  else document.body.style.removeProperty('--lyric-translation-size-em');
  updateSwitch();
}

function updateSwitch() {
  if (!switchCol) return;
  const f = model?.flags || {};
  const s = S();
  for (const b of switchCol.querySelectorAll('button[data-k]')) {
    const k = b.dataset.k;
    const avail = k === 'showTranslation' ? f.hasTranslation : k === 'showRomaji' ? f.hasRomaji : f.hasKaraoke;
    b.classList.toggle('unavailable', !avail);
    b.classList.toggle('active', !!s[k] && !!avail);
  }
}

// --- font size: RNPN's setting is for a full-screen window, scaled down with the window ----------
function computeFontPx() {
  const s = S();
  const base = s.fontSize || 32;
  const k = Math.max(0.5, Math.min(1, innerWidth / screen.width, innerHeight / screen.height));
  return Math.max(16, Math.round(base * k));
}

// --- build -----------------------------------------------------------------------------------
function build(lyr) {
  clearTimeout(lineTimer);
  box.textContent = '';
  lines = [];
  contrib = null;
  cur = -1;
  scrollLine = -1;
  prevScroll = -1;
  shouldTransit = false;
  scrolling = false;
  box.classList.remove('scrolling');
  model = lyr ? { ...lyr, flags: flags(lyr) } : null;
  box.classList.toggle('pure-music', !!model?.flags.pureMusic);
  updateSwitch();
  if (!model?.lyrics?.length) { box.classList.add('empty'); return; }
  box.classList.remove('empty');
  fontPx = computeFontPx();
  box.style.fontSize = `${fontPx}px`;

  const s = S();
  const useKara = s.karaoke && model.flags.hasKaraoke;
  const frag = document.createDocumentFragment();
  model.lyrics.forEach((line, i) => {
    const el = document.createElement('div');
    el.className = 'rnp-lyrics-line';
    el.dataset.i = i;
    const entry = { el, line, words: null, dots: null, glowAnims: [] };
    if (line.isInterlude) {
      el.classList.add('rnp-interlude');
      el.innerHTML = '<div><div class="rnp-interlude-inner pause-breath"><span class="rnp-interlude-dot"></span><span class="rnp-interlude-dot"></span><span class="rnp-interlude-dot"></span></div></div>';
      entry.dots = [...el.querySelectorAll('.rnp-interlude-dot')];
      entry.inner = el.querySelector('.rnp-interlude-inner');
    } else {
      if (useKara && line.dynamicLyric?.length) {
        const k = document.createElement('div');
        k.className = 'rnp-lyrics-line-karaoke';
        entry.words = line.dynamicLyric.map((w) => {
          const span = document.createElement('span');
          span.className = 'rnp-karaoke-word';
          if (w.endsWithSpace || /\s$/.test(w.word)) span.classList.add('end-with-space');
          if (w.isCJK ?? CJK.test(w.word)) span.classList.add('is-cjk');
          const text = w.word.trimEnd();
          if (s.karaokeAnim === 'slide') {
            // dim text, and a bright copy revealed left to right by a moving clip (compositor-only)
            span.innerHTML = '<span class="w-dim"></span><span class="w-clip"><span class="w-fill"></span></span>';
            span.firstChild.textContent = text;
            span.querySelector('.w-fill').textContent = text;
          } else {
            span.textContent = text;
          }
          let glow = null;
          if (s.glow && w.trailing && w.duration >= 1000) {
            glow = document.createElement('span');
            glow.className = 'rnp-word-glow';
            glow.textContent = text;
            span.append(glow);
          }
          k.append(span);
          return { el: span, w, glow };
        });
        el.append(k);
      } else {
        const o = document.createElement('div');
        o.className = 'rnp-lyrics-line-original';
        o.textContent = line.originalLyric;
        el.append(o);
      }
      if (s.showRomaji && line.romanLyric) {
        const r = document.createElement('div');
        r.className = 'rnp-lyrics-line-romaji';
        r.textContent = line.romanLyric;
        el.append(r);
      }
      if (s.showTranslation && line.translatedLyric) {
        const t = document.createElement('div');
        t.className = 'rnp-lyrics-line-translated';
        t.textContent = line.translatedLyric;
        el.append(t);
      }
    }
    frag.append(el);
    lines.push(entry);
  });
  const c = buildContributors();
  if (c) frag.append(c);
  box.append(frag);
  measure();
  tick(true);
}

function buildContributors() {
  const co = model.contributors;
  if (!co) return null;
  const rows = [];
  for (const r of co.roles || []) {
    rows.push(`<div><span class="label">${esc(r.roleName)}: </span>${(r.artistMetaList || []).map((a) => `<a data-hash="#/m/artist/?id=${esc(a.artistId)}">${esc(a.artistName)}</a>`).join(', ')}</div>`);
  }
  if (co.original) rows.push(`<div><span class="label">歌词贡献者: </span><a data-hash="#/m/personal/?uid=${esc(co.original.userid)}">${esc(co.original.name)}</a></div>`);
  if (co.translation) rows.push(`<div><span class="label">翻译贡献者: </span><a data-hash="#/m/personal/?uid=${esc(co.translation.userid)}">${esc(co.translation.name)}</a></div>`);
  if (co.lyricSource) rows.push(`<div><span class="label">歌词来源: </span>${esc(co.lyricSource.name)}</div>`);
  if (!rows.length) return null;
  const el = document.createElement('div');
  el.className = 'rnp-contributors';
  el.innerHTML = `<div class="rnp-contributors-inner">${rows.join('')}</div>`;
  el.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-hash]');
    if (a) { e.stopPropagation(); send('nav', { hash: a.dataset.hash }); import('./main.js').then((m) => m.collapse()); }
  });
  contrib = { el, h: 0 };
  return el;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function measure() {
  heights = lines.map((l) => l.el.clientHeight);
  if (contrib) contrib.h = contrib.el.clientHeight;
}

function relayout(remeasure) {
  if (!model?.lyrics?.length) return;
  const px = computeFontPx();
  if (px !== fontPx) { fontPx = px; box.style.fontSize = `${fontPx}px`; remeasure = true; }
  if (remeasure && !scrolling) measure();
  shouldTransit = false; // RNPN: a resize lays out instantly
  layout(true);
}

// --- time → lines ------------------------------------------------------------------------------
const lyricTime = () => now() + (S().offset || 0);

function currentAt(t) {
  const L = model.lyrics;
  let c = 0;
  for (let i = 0; i < L.length; i++) { if (L[i].time <= t) c = i; else break; }
  const last = L[L.length - 1];
  if (c === L.length - 1 && last.duration && t > last.time + last.duration + 500) c = L.length;
  return c;
}

function scrollAt(t, c) {
  const L = model.lyrics;
  const lead = S().stagger ? STAGGER_LEAD : 0;
  let f = Math.max(0, c - 1);
  for (let i = 0; i < L.length; i++) { if (L[i].time <= t + lead) f = i; else break; }
  return f;
}

function tick(jump) {
  if (!model?.lyrics?.length || !state.window.visible) return;
  clearTimeout(lineTimer);
  const t = lyricTime();
  const c = currentAt(t);
  const f = scrollAt(t, c);
  const seekChanged = seeks() !== lastSeeks;
  lastSeeks = seeks();
  if (f !== scrollLine) {
    scrollLine = f;
    if (!scrolling) layout(false);
  }
  if (c !== cur || jump || seekChanged) setCurrent(c, t, jump || seekChanged);
  updateThumb();
  scheduleNext(t);
}

// Sleep until the next line starts (or starts moving): no work between lines.
function scheduleNext(t) {
  if (!state.playing || !model) return;
  const lead = S().stagger ? STAGGER_LEAD : 0;
  let next = Infinity;
  for (const l of model.lyrics) {
    for (const e of [l.time - lead, l.time]) if (e > t + 1 && e < next) next = e;
  }
  const last = model.lyrics[model.lyrics.length - 1];
  if (last?.duration) { const end = last.time + last.duration + 501; if (end > t + 1 && end < next) next = end; }
  if (next < Infinity) lineTimer = setTimeout(() => tick(false), Math.min(next - t, 2 ** 31 - 1));
}

// --- layout pass (RNPN B@365402) ---------------------------------------------------------------
function effects(k) {
  const s = S();
  return {
    scale: s.zoom ? Math.pow(Math.max(1 - 0.2 * k, 0), 3) * 0.3 + 0.7 : 1,
    blur: s.blur && !scrolling ? (k === 0 ? 0 : Math.min(0.5 + k, 4.5)) : 0,
    opacity: s.fade && !scrolling ? (k <= 1 ? 1 : Math.max(1 - 0.4 * (k - 1), 0)) : 1,
  };
}

function layout(instant) {
  if (!model?.lyrics?.length) return;
  const n = lines.length;
  const H = box.clientHeight;
  const space = 1.2 * fontPx;
  const anchor = scrolling ? scrollFocus : scrollLine;
  const d = Math.max(0, Math.min(anchor, n - 1));
  const h = heights.slice();
  const fx = lines.map((_, i) => effects(Math.abs(i - d)));
  const top = new Array(n);
  const align = (S().alignment ?? 50) / 100;
  top[d] = H * align - h[d] / 2;
  if (model.lyrics[d].isInterlude && !scrolling) h[d] += 50;
  for (let i = d - 1; i >= 0; i--) top[i] = top[i + 1] - h[i] * fx[i].scale - space;
  for (let i = d + 1; i < n; i++) top[i] = top[i - 1] + h[i - 1] * fx[i - 1].scale + space;

  const moving = !instant && shouldTransit && !scrolling && S().stagger && prevScroll >= 0 && anchor !== prevScroll;
  const sign = anchor > prevScroll ? 1 : -1;
  const transit = !instant && (shouldTransit || scrolling);
  const delay = (off) => (moving ? 50 * (Math.max(-4, Math.min(4, off)) * sign + 4) : 0);
  for (let i = 0; i < n; i++) {
    const el = lines[i].el;
    const st = el.style;
    // far off screen: skip painting them at all
    const visible = top[i] + h[i] > -H * 0.6 && top[i] < H * 1.6;
    el.classList.toggle('offscreen', !visible);
    st.transitionDuration = transit ? '500ms' : '0ms';
    st.transitionDelay = `${delay(i - d)}ms`;
    st.transform = `translateY(${top[i]}px) scale(${fx[i].scale})`;
    st.filter = fx[i].blur ? `blur(${fx[i].blur}px)` : '';
    st.opacity = fx[i].opacity;
  }
  if (contrib) {
    const st = contrib.el.style;
    const ctop = top[n - 1] + h[n - 1] * fx[n - 1].scale + Math.min(1.5 * space, 90);
    st.transitionDuration = transit ? '500ms' : '0ms';
    st.transitionDelay = `${delay(n - d)}ms`;
    st.transform = `translateY(${ctop}px)`;
  }
  prevScroll = anchor;
  shouldTransit = true;
}

// --- highlight, karaoke, glow, dots ------------------------------------------------------------
function setCurrent(c, t, resync) {
  const prev = cur;
  cur = c;
  for (let i = 0; i < lines.length; i++) lines[i].el.setAttribute('offset', String(i - c));
  if (prev !== c && prev >= 0 && lines[prev]) leaveLine(lines[prev]);
  const entry = lines[c];
  if (!entry) return;
  if (entry.words) startWords(entry, t, resync);
  if (entry.dots) startDots(entry, t);
}

function wordStart(entry, w) {
  const lineT = entry.line.dynamicLyricTime ?? entry.line.time;
  return w.time >= lineT - 1000 ? w.time : lineT + w.time;
}

function startWords(entry, t) {
  const slide = S().karaokeAnim === 'slide';
  for (const wd of entry.words) {
    const start = wordStart(entry, wd.w);
    const dur = Math.max(1, wd.w.duration);
    const p = Math.max(0, Math.min(1, (t - start) / dur));
    const el = wd.el;
    const target = slide ? el.querySelector('.w-clip') : el;
    const inner = slide ? el.querySelector('.w-fill') : null;
    if (!state.playing) {
      setInstant(el, target, inner, p, slide);
    } else {
      // start from the current point, then run to the end on the compositor
      setInstant(el, target, inner, p, slide);
      void el.offsetWidth;
      const remain = Math.max(0, start + dur - t);
      const wait = Math.max(0, start - t);
      if (slide) {
        target.style.transition = `transform ${dur * (1 - p) || remain}ms linear ${wait}ms`;
        inner.style.transition = `transform ${dur * (1 - p) || remain}ms linear ${wait}ms`;
        target.style.transform = 'translateX(0)';
        inner.style.transform = 'translateX(0)';
        el.style.transition = `transform ${dur + 150}ms ease ${wait}ms`;
        el.style.transform = 'translateY(-1px)';
      } else {
        el.style.transition = `opacity ${dur * (1 - p)}ms linear ${wait}ms, transform ${(dur + 150) * (1 - p)}ms ease ${wait}ms`;
        el.style.opacity = '1';
        el.style.transform = 'translateY(-2px)';
      }
    }
    if (wd.glow) syncGlow(wd, start, dur, t);
  }
}

function setInstant(el, target, inner, p, slide) {
  el.style.transition = 'none';
  if (slide) {
    target.style.transition = 'none';
    inner.style.transition = 'none';
    target.style.transform = `translateX(${(p - 1) * 100}%)`;
    inner.style.transform = `translateX(${(1 - p) * 100}%)`;
    el.style.transform = `translateY(${-1 * p}px)`;
  } else {
    el.style.opacity = String(0.4 + 0.6 * p);
    el.style.transform = `translateY(${-2 * p}px)`;
  }
}

function syncGlow(wd, start, dur, t) {
  const D = dur + 500;
  if (!wd.anim) {
    wd.anim = wd.glow.animate([
      { opacity: 0 },
      { opacity: 1, offset: (0.6 * dur) / D },
      { opacity: 1, offset: dur / D },
      { opacity: 0 },
    ], { duration: D, fill: 'forwards', easing: 'linear' });
  }
  const a = wd.anim;
  a.currentTime = Math.max(0, Math.min(D, t - start));
  if (t < start) {
    a.pause();
    a.currentTime = 0;
    if (state.playing) { clearTimeout(wd.glowTimer); wd.glowTimer = setTimeout(() => { if (state.playing) a.play(); }, start - t); }
  } else if (state.playing) a.play();
  else a.pause();
}

function leaveLine(entry) {
  if (entry.words) {
    const slide = S().karaokeAnim === 'slide';
    for (const wd of entry.words) {
      const el = wd.el;
      el.style.transition = '';
      el.style.opacity = '';
      el.style.transform = '';
      if (slide) {
        for (const x of [el.querySelector('.w-clip'), el.querySelector('.w-fill')]) { x.style.transition = ''; x.style.transform = ''; }
      }
      clearTimeout(wd.glowTimer);
      // a glow that is still fading out finishes; one that never started stays off
      if (wd.anim && wd.anim.playState !== 'running') { wd.anim.cancel(); wd.anim = null; }
    }
  }
  if (entry.dots) {
    entry.inner.classList.add('pause-breath');
    for (const d of entry.dots) { d.style.transition = ''; d.style.opacity = ''; d.style.transform = ''; }
  }
}

function startDots(entry, t) {
  const l = entry.line;
  const per = Math.floor(l.duration / 3);
  entry.inner.classList.toggle('pause-breath', !state.playing);
  entry.dots.forEach((dot, k) => {
    const start = l.time + per * k;
    const p = Math.max(0, Math.min(1, (t - start) / Math.max(per, 1)));
    dot.style.transition = 'none';
    dot.style.opacity = String(0.2 + 0.7 * p);
    dot.style.transform = `scale(${0.9 + 0.1 * p})`;
    if (state.playing && p < 1) {
      void dot.offsetWidth;
      const wait = Math.max(0, start - t);
      const rest = per * (1 - p);
      dot.style.transition = `opacity ${rest}ms linear ${wait}ms, transform ${rest}ms linear ${wait}ms`;
      dot.style.opacity = '0.9';
      dot.style.transform = 'scale(1)';
    }
  });
}

function onPlayState() {
  if (!model?.lyrics?.length) return;
  clearTimeout(lineTimer);
  const t = lyricTime();
  if (lines[cur]) {
    if (lines[cur].words) startWords(lines[cur], t);
    if (lines[cur].dots) startDots(lines[cur], t);
  }
  if (state.playing) {
    tick(false);
    // scrolled while paused: playing returns to the current line as a wheel would
    if (scrolling) { clearTimeout(returnTimer); returnTimer = setTimeout(() => endScrolling(), RETURN_MS); }
  } else if (scrolling) clearTimeout(returnTimer);
}

// --- wheel scrolling (RNPN lyrics.js:537-606) --------------------------------------------------
function onWheel(e) {
  if (!model?.lyrics?.length) return;
  e.preventDefault();
  const L = model.lyrics;
  if (!scrolling) { scrolling = true; scrollFocus = Math.max(0, scrollLine); box.classList.add('scrolling'); }
  const dir = e.deltaY > 0 ? 1 : -1;
  let i = scrollFocus + dir;
  while (i >= 0 && i < L.length && L[i].isInterlude) i += dir;
  if (i >= 0 && i < L.length) scrollFocus = i;
  layout(false);
  updateThumb();
  clearTimeout(returnTimer);
  if (state.playing) returnTimer = setTimeout(() => endScrolling(), RETURN_MS);
}

function endScrolling(delay = 0) {
  clearTimeout(returnTimer);
  const go = () => {
    scrolling = false;
    box.classList.remove('scrolling');
    measure();
    layout(false);
    updateThumb();
  };
  if (delay) returnTimer = setTimeout(go, delay); else go();
}

function onLineClick(e) {
  const el = e.target.closest('.rnp-lyrics-line');
  // unsynced lyrics have no times (parse.js gives them 999999999)
  if (!el || box.classList.contains('pure-music') || model?.unsynced) return;
  const line = model?.lyrics[Number(el.dataset.i)];
  if (!line || line.isInterlude) return;
  const sec = (line.time + 50 - (S().offset || 0)) / 1000;
  send('seek', { sec });
  if (!state.playing) send('toggle');
  if (scrolling) endScrolling();
}

// --- scrollbar -----------------------------------------------------------------------------------
function realLines() {
  return model ? model.lyrics.map((l, i) => (l.isInterlude ? -1 : i)).filter((i) => i >= 0) : [];
}

function updateThumb() {
  const idx = realLines();
  if (!idx.length) { thumb.style.opacity = '0'; return; }
  const H = scrollbar.clientHeight;
  const th = Math.max(H / idx.length, 30);
  const at = scrolling ? scrollFocus : Math.max(0, scrollLine);
  let k = idx.findIndex((i) => i >= at);
  if (k < 0) k = idx.length - 1;
  thumb.style.height = `${th}px`;
  thumb.style.transform = `translateY(${idx.length > 1 ? (k * (H - th)) / (idx.length - 1) : 0}px)`;
  thumb.style.opacity = '';
}

function bindScrollbar() {
  let dragging = false;
  const pick = (y) => {
    const idx = realLines();
    if (!idx.length) return;
    const r = scrollbar.getBoundingClientRect();
    const k = Math.round(Math.max(0, Math.min(1, (y - r.top) / r.height)) * (idx.length - 1));
    if (!scrolling) { scrolling = true; box.classList.add('scrolling'); }
    scrollFocus = idx[k];
    layout(false);
    updateThumb();
  };
  scrollbar.addEventListener('pointerdown', (e) => {
    dragging = true;
    scrollbar.setPointerCapture(e.pointerId);
    scrollbar.classList.add('dragging');
    clearTimeout(returnTimer);
    pick(e.clientY);
  });
  scrollbar.addEventListener('pointermove', (e) => { if (dragging) pick(e.clientY); });
  scrollbar.addEventListener('pointerup', () => {
    dragging = false;
    scrollbar.classList.remove('dragging');
    if (state.playing) returnTimer = setTimeout(() => endScrolling(), RETURN_MS);
  });
}

/** For the copy mode and tests. */
export function lyricState() {
  return { cur, scrollLine, scrolling, fontPx, n: lines.length };
}
