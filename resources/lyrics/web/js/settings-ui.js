// 设置: the popover under the top-right settings button. It replaces RefinedNowPlayingNext's menu
// (8 tabs, 46 controls) with B's own groups (bspec settings.md §4) and edits the keys in
// settings.js; every change goes through update(), so the page reacts while the popover is open.
// Built on first open, display:none while closed.
import { state, watch } from './state.js';
import { DEFAULTS, update, reset } from './settings.js';
import { flags } from './parse.js';

const BNCM_VERSION = '1.3.4'; // the BetterNCM API the injector provides (src/config.mjs BNCM_VERSION)
const RNPN_VERSION = '3.0.2';

const svg = (inner) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICONS = {
  lyrics: svg('<path d="M4 5.5h12M4 9.5h8M4 13.5h10"/><path d="M15 12v4.2" stroke-width="1.4"/><circle cx="13.6" cy="16.3" r="1.4" fill="currentColor" stroke="none"/>'),
  look: svg('<circle cx="10" cy="10" r="6.8"/><path d="M10 3.2a6.8 6.8 0 0 1 0 13.6z" fill="currentColor" stroke="none"/>'),
  bg: svg('<rect x="3" y="4" width="14" height="12" rx="2.2"/><path d="M3.6 14.2l3.8-3.7 2.9 2.8 2.1-2 3.9 3.6"/><circle cx="12.9" cy="7.9" r="1.2"/>'),
  cover: svg('<rect x="3.5" y="2.8" width="10" height="10" rx="1.8"/><path d="M3.5 15.6h13M3.5 18h8"/>'),
  font: svg('<path d="M2.8 15.5 6.6 5l3.8 10.5M4.1 12h5" /><path d="M16.8 10.6v4.9"/><circle cx="14.6" cy="13.2" r="2.2"/>'),
  about: svg('<circle cx="10" cy="10" r="7"/><path d="M10 9v4.5"/><circle cx="10" cy="6.4" r=".45" fill="currentColor"/>'),
};
const RESET_ICON = svg('<path d="M4.6 8.2A5.6 5.6 0 1 1 4.4 12"/><path d="M4.2 4.6v3.8H8"/>');

const SEG = (pairs) => pairs.map(([v, l]) => ({ v, l }));
const pct = (v) => `${Math.round(v * 100)}%`;

// Rows: switch | seg | slider | stepper | fonts | note | info | reset. `when` hides a row that does
// not apply; `stack` puts a wide control under its label. A switch's `avail` names the lyric flag
// (parse.js) it needs: without it the row says the current song has none. A switch with `get` and
// `set` shows a state that is not a setting (copy mode).
const copyModeOn = () => document.body.classList.contains('bncm-copy-mode');
const GROUPS = [
  {
    id: 'lyrics', label: '歌词', sections: [
      {
        title: '显示', rows: [
          { type: 'switch', k: 'showTranslation', label: '翻译', avail: 'hasTranslation', missing: '当前歌曲没有翻译' },
          { type: 'switch', k: 'showRomaji', label: '罗马音', avail: 'hasRomaji', missing: '当前歌曲没有罗马音' },
          { type: 'switch', k: 'karaoke', label: '逐字歌词', help: '有逐字时间轴的歌词按字高亮', avail: 'hasKaraoke', missing: '当前歌曲没有逐字时间轴' },
          { type: 'seg', k: 'contributors', label: '歌词贡献者', options: SEG([['show', '总是'], ['hover', '悬停时'], ['hide', '隐藏']]) },
          {
            type: 'switch', label: '复制模式', help: '整首歌词变成可选中复制的文字，Esc 退出',
            get: copyModeOn,
            set: async (v) => (await import('./copy-mode.js')).toggleCopyMode(v),
          },
        ],
      },
      {
        title: '大小', rows: [
          { type: 'slider', k: 'fontSize', label: '歌词大小', help: '随窗口大小自动缩放', min: 16, max: 72, step: 1, preview: true },
          { type: 'slider', k: 'translationEm', label: '翻译大小', help: '相对歌词原文', min: 0.3, max: 1.5, step: 0.05, fmt: pct, auto: 0.8 },
          { type: 'seg', k: 'translationWeight', label: '翻译字重', options: SEG([['regular', '常规'], ['medium', '中等'], ['semibold', '加粗']]) },
          { type: 'slider', k: 'romajiEm', label: '罗马音大小', help: '相对歌词原文', min: 0.3, max: 1.5, step: 0.05, fmt: pct },
          { type: 'switch', k: 'bold', label: '原文加粗' },
        ],
      },
      {
        title: '动效', rows: [
          { type: 'seg', k: 'alignment', label: '当前行位置', options: SEG([[30, '偏上'], [50, '居中']]) },
          { type: 'seg', k: 'karaokeAnim', label: '逐字效果', options: SEG([['float', '上浮'], ['slide', '扫光']]) },
          { type: 'seg', k: 'timing', label: '滚动曲线', options: SEG([['smooth', '平滑'], ['sharp', '急促'], ['lazy', '温和'], ['easeout', '缓出']]) },
          { type: 'switch', k: 'stagger', label: '错位滚动', help: '换行时各行依次跟上' },
          { type: 'switch', k: 'zoom', label: '远处歌词缩小' },
          { type: 'switch', k: 'fade', label: '远处歌词变淡' },
          { type: 'switch', k: 'blur', label: '远处歌词模糊', help: '较耗电' },
          { type: 'switch', k: 'glow', label: '长音发光', help: '句末长音唱到时发光' },
        ],
      },
      {
        title: '时间', rows: [
          { type: 'stepper', k: 'offset', label: '歌词偏移', help: '正值让歌词提前显示', step: 100, min: -10000, max: 10000 },
        ],
      },
    ],
  },
  {
    id: 'look', label: '外观', sections: [
      {
        rows: [
          { type: 'seg', k: 'scheme', label: '文字颜色', help: '白色接近 Apple Music，右上角可切换', options: SEG([['auto', '跟随系统'], ['dark', '白色'], ['light', '黑色']]) },
          { type: 'seg', k: 'accent', label: '主题色', help: '从封面取色', options: SEG([['off', '关'], ['primary', '鲜艳'], ['secondary', '柔和'], ['tertiary', '偏色']]) },
          { type: 'seg', k: 'textEffect', label: '文字效果', help: '辉光使用主题色', options: SEG([['none', '无'], ['shadow', '阴影'], ['glow', '辉光']]) },
        ],
      },
      {
        title: '播放控件', rows: [
          { type: 'switch', k: 'showControls', label: '显示播放控件', help: '关闭后隐藏进度条、播放按钮和喜欢按钮' },
        ],
      },
    ],
  },
  {
    id: 'bg', label: '背景', sections: [
      {
        rows: [
          { type: 'seg', k: 'bgType', label: '背景类型', help: '纯色最省电', options: SEG([['blur', '模糊'], ['gradient', '渐变'], ['solid', '纯色']]) },
          { type: 'slider', k: 'bgBlur', label: '模糊程度', min: 0, max: 128, step: 1, heavy: true, when: (s) => s.bgType === 'blur' },
          { type: 'slider', k: 'bgDim', label: '暗化', min: 0, max: 100, step: 1, fmt: (v) => `${v}%`, heavy: true, when: (s) => s.bgType === 'blur' },
          { type: 'switch', k: 'gradientDynamic', label: '缓慢流动', when: (s) => s.bgType === 'gradient' },
          { type: 'slider', k: 'gradientDim', label: '暗化', min: 0, max: 100, step: 1, fmt: (v) => `${v}%`, when: (s) => s.bgType === 'gradient' },
          { type: 'note', text: '使用封面的主色铺满背景。', when: (s) => s.bgType === 'solid' },
        ],
      },
    ],
  },
  {
    id: 'cover', label: '封面与信息', tab: '封面', sections: [
      {
        title: '封面', rows: [
          { type: 'seg', k: 'coverShape', label: '形状', options: SEG([['square', '方形'], ['round', '圆形']]) },
          { type: 'seg', k: 'coverShadow', label: '阴影', help: '彩色：用封面颜色的柔和光晕', options: SEG([['colorful', '彩色'], ['plain', '普通']]) },
          { type: 'seg', k: 'coverPos', label: '位置', options: SEG([['center', '居中'], ['bottomLeft', '靠左下']]) },
        ],
      },
      {
        title: '歌曲信息', rows: [
          { type: 'seg', k: 'subtitle', label: '歌曲副标题', help: '标题下方的别名或译名', stack: true, options: SEG([['alias', '别名优先'], ['trans', '译名优先'], ['both', '都显示'], ['none', '不显示']]) },
        ],
      },
    ],
  },
  {
    id: 'font', label: '字体', sections: [
      {
        rows: [
          { type: 'seg', k: 'font', label: '歌词字体', help: '用于歌词、歌名和歌曲信息', options: SEG([['system', '系统'], ['custom', '自定义']]) },
        ],
      },
      { title: '字体列表', when: (s) => s.font === 'custom', rows: [{ type: 'fonts' }] },
    ],
  },
  {
    id: 'about', label: '关于', sections: [
      {
        rows: [
          // state.version is this project's own version (package.json), sent with `open`
          { type: 'info', label: 'BetterNCM', value: () => (state.version ? `${state.version}（接口 ${BNCM_VERSION}）` : BNCM_VERSION) },
          { type: 'info', label: '视觉设计', value: `RefinedNowPlayingNext ${RNPN_VERSION}` },
          { type: 'info', label: '作者', value: 'MiHN' },
          { type: 'info', label: '原作者', value: 'solstice23' },
          { type: 'info', label: '性能与视觉优化', value: 'OyangDer' },
          { type: 'note', text: '歌词窗口沿用 RefinedNowPlayingNext 的界面设计（MIT 许可），以更省电的方式重新实现。' },
        ],
      },
      { rows: [{ type: 'reset' }] },
    ],
  },
];

// Fonts offered in the list's suggestions and as presets, when installed: [CSS family, 中文名].
const FONT_CHOICES = [
  ['PingFang SC', '苹方'], ['Hiragino Sans GB', '冬青黑体'], ['Source Han Sans SC', '思源黑体'], ['Noto Sans CJK SC', 'Noto Sans 中文'],
  ['Source Han Serif SC', '思源宋体'], ['Noto Serif CJK SC', 'Noto Serif 中文'], ['Songti SC', '宋体-简'], ['STSong', '华文宋体'],
  ['Kaiti SC', '楷体-简'], ['STKaiti', '华文楷体'], ['LXGW WenKai', '霞鹜文楷'], ['Yuanti SC', '圆体-简'], ['Lantinghei SC', '兰亭黑-简'],
  ['Weibei SC', '魏碑-简'], ['Libian SC', '隶变-简'], ['HanziPen SC', '翩翩体-简'], ['STHeiti', '华文黑体'],
  ['SF Pro Display', 'SF Pro'], ['Helvetica Neue', 'Helvetica Neue'], ['Avenir Next', 'Avenir Next'], ['Gill Sans', 'Gill Sans'],
  ['Futura', 'Futura'], ['Georgia', 'Georgia'], ['New York', 'New York'],
];
const PRESETS = ['PingFang SC', 'Source Han Sans SC', 'Source Han Serif SC', 'LXGW WenKai'];

let root = null;
let side = null;
let main = null;
let isOpen = false;
let groupId = 'lyrics';
let jumpUntil = 0; // while a jump scrolls, the tab bar keeps the group it was sent to
let swallowTimer = 0;
const syncs = [];
const S = () => state.settings || DEFAULTS;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function button(cls, html, title) {
  const b = el('button', cls);
  b.type = 'button';
  if (html) b.innerHTML = html;
  if (title) { b.title = title; b.setAttribute('aria-label', title); }
  return b;
}

// --- controls ---------------------------------------------------------------------------------
function rowShell(r) {
  const row = el('div', `bncm-set-row bncm-set-row-${r.type}${r.stack ? ' stack' : ''}`);
  const text = el('div', 'bncm-set-text');
  if (r.label) text.append(el('div', 'bncm-set-label', r.label));
  if (r.help) text.append(el('div', 'bncm-set-help', r.help));
  row.append(text);
  return { row, text };
}

function switchRow(r) {
  const { row, text } = rowShell(r);
  if (r.avail) {
    // in place of the help line while the current song lacks it; no lyrics yet: nothing to say
    const help = text.querySelector('.bncm-set-help');
    const missing = el('div', 'bncm-set-help bncm-set-missing', r.missing);
    text.append(missing);
    syncs.push(() => {
      const none = !!state.lyrics && !flags(state.lyrics)[r.avail];
      missing.hidden = !none;
      if (help) help.hidden = none;
    });
  }
  const sw = button('bncm-set-switch');
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', r.label);
  sw.append(el('i'));
  row.append(sw);
  const get = r.get || ((s) => s[r.k]);
  const paint = (s = S()) => sw.setAttribute('aria-checked', String(!!get(s)));
  // the whole row toggles, like a macOS settings row
  row.addEventListener('click', async () => {
    if (r.set) { await r.set(!get(S())); paint(); } else update({ [r.k]: !S()[r.k] });
  });
  syncs.push(paint);
  return row;
}

function segmented(options, value, onPick, label) {
  const seg = el('div', 'bncm-set-seg');
  seg.setAttribute('role', 'radiogroup');
  if (label) seg.setAttribute('aria-label', label);
  seg.style.setProperty('--n', String(options.length));
  // equal segments, as wide as the longest label
  const longest = Math.max(...options.map((o) => o.l.length));
  seg.style.setProperty('--w', `${Math.max(46, longest * 13 + 22)}px`);
  seg.append(el('i', 'bncm-set-seg-pill'));
  const btns = options.map((o) => {
    const b = button('', null);
    b.textContent = o.l;
    b.setAttribute('role', 'radio');
    b.addEventListener('click', (e) => { e.stopPropagation(); onPick(o.v); });
    seg.append(b);
    return b;
  });
  const sync = (v) => {
    const i = options.findIndex((o) => o.v === v);
    seg.style.setProperty('--i', String(Math.max(i, 0)));
    seg.classList.toggle('none', i < 0);
    btns.forEach((b, j) => b.setAttribute('aria-checked', String(j === i)));
  };
  sync(value);
  return { seg, sync };
}

function segRow(r) {
  const { row } = rowShell(r);
  const { seg, sync } = segmented(r.options, S()[r.k], (v) => update({ [r.k]: v }), r.label);
  // the pill slides only when picked, not when the page or a reset changes the value; capture,
  // because the buttons stop the click's propagation
  seg.addEventListener('click', () => {
    seg.classList.add('animate');
    clearTimeout(seg._t);
    seg._t = setTimeout(() => seg.classList.remove('animate'), 300);
  }, true);
  row.append(seg);
  syncs.push((s) => sync(s[r.k]));
  return row;
}

function resetButton(title, onClick) {
  const b = button('bncm-set-reset', RESET_ICON, title);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function sliderRow(r) {
  const { row, text } = rowShell({ ...r, stack: true });
  row.classList.add('stack');
  const val = el('div', 'bncm-set-val');
  const head = el('div', 'bncm-set-head-line');
  head.append(text, val);
  row.prepend(head);
  const line = el('div', 'bncm-set-slider-line');
  const input = el('input', 'bncm-set-range');
  Object.assign(input, { type: 'range', min: r.min, max: r.max, step: r.step });
  input.setAttribute('aria-label', r.label);
  const def = DEFAULTS[r.k];
  const rst = resetButton(r.auto && !def ? '恢复自动' : '恢复默认', () => update({ [r.k]: def }));
  line.append(input, rst);
  row.append(line);

  const paint = (v) => {
    const isAuto = r.auto && !v;
    const shown = isAuto ? r.auto : v;
    input.style.setProperty('--p', `${((shown - r.min) / (r.max - r.min)) * 100}%`);
    input.classList.toggle('auto', !!isAuto);
    if (r.preview) {
      // "Aa" at a size that follows the setting, rather than a number of pixels nobody sees
      val.innerHTML = '';
      const aa = el('span', 'bncm-set-aa', 'Aa');
      aa.style.fontSize = `${Math.round(11 + ((v - r.min) / (r.max - r.min)) * 13)}px`;
      val.append(aa);
    } else {
      val.textContent = isAuto ? '自动' : r.fmt ? r.fmt(v) : String(v);
    }
    rst.classList.toggle('shown', v !== def);
  };

  // While dragging: the label and fill follow every step; settings are written at most once a
  // frame, and the background (re-rendered by the host) only after the pointer pauses.
  let dragging = false;
  let pending = null;
  let raf = 0;
  let timer = 0;
  const flush = () => {
    cancelAnimationFrame(raf); clearTimeout(timer); raf = 0;
    if (pending != null && pending !== S()[r.k]) update({ [r.k]: pending });
    pending = null;
  };
  // the release can land outside the input, so it is caught on the window
  const release = () => { dragging = false; };
  input.addEventListener('pointerdown', () => {
    dragging = true;
    addEventListener('pointerup', release, { once: true, capture: true });
    addEventListener('pointercancel', release, { once: true, capture: true });
  });
  input.addEventListener('input', () => {
    pending = Number(input.value);
    paint(pending);
    if (r.heavy) { clearTimeout(timer); timer = setTimeout(flush, 180); } else if (!raf) raf = requestAnimationFrame(flush);
  });
  input.addEventListener('change', () => { dragging = false; flush(); });
  syncs.push((s) => {
    if (dragging) return;
    const v = s[r.k];
    input.value = String(r.auto && !v ? r.auto : v);
    paint(v);
  });
  return row;
}

function stepperRow(r) {
  const { row } = rowShell(r);
  const box = el('div', 'bncm-set-stepper');
  const minus = button('', svg('<path d="M5.5 10h9"/>'), '减少 0.1 秒');
  const val = el('div', 'bncm-set-stepper-val');
  const plus = button('', svg('<path d="M5.5 10h9M10 5.5v9"/>'), '增加 0.1 秒');
  box.append(minus, val, plus);
  const rst = resetButton('恢复为 0', () => update({ [r.k]: 0 }));
  row.append(rst, box);
  const fmt = (ms) => (ms === 0 ? '0.0 秒' : `${ms > 0 ? '+' : '−'}${(Math.abs(ms) / 1000).toFixed(1)} 秒`);
  const step = (d) => {
    const v = Math.min(r.max, Math.max(r.min, Math.round(((S()[r.k] || 0) + d) / r.step) * r.step));
    if (v !== S()[r.k]) update({ [r.k]: v });
  };
  // press and hold repeats, faster after a moment
  for (const [b, d] of [[minus, -r.step], [plus, r.step]]) {
    let t = 0;
    let n = 0;
    const stop = () => { clearTimeout(t); t = 0; };
    // a disabled button may never see its pointerup, so the repeat also ends at the limit
    const repeat = () => {
      if (b.disabled || !isOpen) return stop();
      step(d); n++; t = setTimeout(repeat, n > 8 ? 50 : 110);
    };
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      step(d); n = 0;
      t = setTimeout(repeat, 400);
      b.setPointerCapture?.(e.pointerId);
    });
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointercancel', stop);
    b.addEventListener('lostpointercapture', stop);
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); step(d); } });
  }
  syncs.push((s) => {
    const v = s[r.k] || 0;
    val.textContent = fmt(v);
    val.classList.toggle('zero', v === 0);
    rst.classList.toggle('shown', v !== 0);
    minus.disabled = v <= r.min;
    plus.disabled = v >= r.max;
  });
  return row;
}

// --- fonts ----------------------------------------------------------------------------------------
const installedCache = new Map();
/** Whether a font family is installed: text drawn in it differs from both generic fallbacks. */
function installed(family) {
  if (installedCache.has(family)) return installedCache.get(family);
  const ctx = (installed.ctx ||= document.createElement('canvas').getContext('2d'));
  const sample = '永和九年岁在癸丑 AaBbWwIil1@';
  let yes = false;
  for (const base of ['monospace', 'serif']) {
    ctx.font = `40px ${base}`;
    const w0 = ctx.measureText(sample).width;
    ctx.font = `40px "${family}", ${base}`;
    if (ctx.measureText(sample).width !== w0) { yes = true; break; }
  }
  installedCache.set(family, yes);
  return yes;
}
const fontLabel = (f) => FONT_CHOICES.find(([fam]) => fam === f)?.[1];
const cssFamily = (f) => `"${f.replace(/"/g, '')}", "PingFang SC", sans-serif`;

function fontsRow() {
  const row = el('div', 'bncm-set-row bncm-set-fonts stack');
  row.append(el('div', 'bncm-set-help', '前面的字体缺字时，依次使用后面的字体。列表为空时使用系统字体。'));
  const list = el('ol', 'bncm-set-fontlist');
  const add = el('div', 'bncm-set-fontadd');
  const input = el('input', 'bncm-set-input');
  Object.assign(input, { type: 'text', placeholder: '输入或选择字体名称', spellcheck: false, autocomplete: 'off' });
  input.setAttribute('aria-label', '字体名称');
  const dl = el('datalist');
  dl.id = 'bncm-set-fontnames';
  input.setAttribute('list', dl.id);
  const addBtn = button('bncm-set-btn', null);
  addBtn.textContent = '添加';
  add.append(input, addBtn, dl);
  const chips = el('div', 'bncm-set-chips');
  row.append(list, add, chips);

  const setList = (fl) => update({ fontList: fl });
  const addFont = (name) => {
    const f = name.trim().replace(/^["']|["']$/g, '').trim();
    if (!f) return;
    const fl = S().fontList.filter((x) => x.toLowerCase() !== f.toLowerCase());
    setList([...fl, f]);
    input.value = '';
    addBtn.disabled = true;
  };
  addBtn.disabled = true;
  input.addEventListener('input', () => { addBtn.disabled = !input.value.trim(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addFont(input.value); }
    // Esc first clears the field; an empty field lets it through to the popover's handler
    if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; addBtn.disabled = true; }
  });
  addBtn.addEventListener('click', () => addFont(input.value));

  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    for (const [fam, zh] of FONT_CHOICES) {
      if (!installed(fam)) continue;
      const o = el('option');
      o.value = fam;
      o.label = zh === fam ? fam : `${zh}  ${fam}`;
      dl.append(o);
    }
  };
  input.addEventListener('focus', fill);

  let shownKey = null;
  syncs.push((s) => {
    const fl = s.fontList || [];
    // rebuilt only when the list changes, not on every slider step elsewhere
    const key = fl.join('\n');
    if (key === shownKey) return;
    shownKey = key;
    list.textContent = '';
    fl.forEach((f, i) => {
      const li = el('li', 'bncm-set-font');
      const name = el('span', 'bncm-set-font-name', f);
      name.style.fontFamily = cssFamily(f);
      const zh = fontLabel(f);
      if (zh && zh !== f) name.append(el('span', 'bncm-set-font-zh', zh));
      if (!installed(f)) { li.classList.add('missing'); name.append(el('span', 'bncm-set-font-zh', '未安装')); }
      const up = button('bncm-set-icon', svg('<path d="M6 12l4-4 4 4"/>'), '上移');
      const down = button('bncm-set-icon', svg('<path d="M6 8l4 4 4-4"/>'), '下移');
      const del = button('bncm-set-icon', svg('<path d="M6.5 6.5l7 7M13.5 6.5l-7 7"/>'), '移除');
      up.disabled = i === 0;
      down.disabled = i === fl.length - 1;
      const move = (d) => { const n = fl.slice(); [n[i], n[i + d]] = [n[i + d], n[i]]; setList(n); };
      up.addEventListener('click', () => move(-1));
      down.addEventListener('click', () => move(1));
      del.addEventListener('click', () => setList(fl.filter((_, j) => j !== i)));
      li.append(name, up, down, del);
      list.append(li);
    });
    list.hidden = !fl.length;
    chips.textContent = '';
    const presets = PRESETS.filter((p) => installed(p) && !fl.includes(p));
    if (presets.length) {
      chips.append(el('span', 'bncm-set-chips-label', '常用'));
      for (const p of presets) {
        const c = button('bncm-set-chip', null, `添加${fontLabel(p)}`);
        c.textContent = `+ ${fontLabel(p)}`;
        c.style.fontFamily = cssFamily(p);
        c.addEventListener('click', () => addFont(p));
        chips.append(c);
      }
    }
  });
  return row;
}

// --- 关于 -------------------------------------------------------------------------------------------
function infoRow(r) {
  const { row } = rowShell(r);
  row.append(el('div', 'bncm-set-value', typeof r.value === 'function' ? r.value() : r.value));
  return row;
}
function noteRow(r) {
  return el('div', 'bncm-set-row bncm-set-note', r.text);
}
function resetRow() {
  const row = el('div', 'bncm-set-row bncm-set-resetall stack');
  const b = button('bncm-set-danger', null);
  const help = el('div', 'bncm-set-help', '只重置歌词窗口自己的设置，RefinedNowPlayingNext 的设置不受影响。');
  row.append(b, help);
  let armed = 0;
  const disarm = () => { clearTimeout(armed); armed = 0; b.textContent = '恢复默认设置'; b.classList.remove('armed'); };
  disarm();
  b.addEventListener('click', () => {
    if (!armed) {
      b.textContent = '再点一次，恢复全部默认设置';
      b.classList.add('armed');
      armed = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    reset();
  });
  syncs.push(() => { if (!isOpen) disarm(); });
  return row;
}

const BUILDERS = { switch: switchRow, seg: segRow, slider: sliderRow, stepper: stepperRow, fonts: fontsRow, info: infoRow, note: noteRow, reset: resetRow };

// --- popover ----------------------------------------------------------------------------------------
function loadCss() {
  if (document.querySelector('link[data-bncm-settings]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = 'css/settings.css';
  l.dataset.bncmSettings = '';
  document.head.append(l);
}

function build() {
  loadCss();
  root = el('div', 'bncm-settings');
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', '设置');
  // every group in one scrolling column; the tab bar above jumps to one and follows the scroll
  side = el('nav', 'bncm-set-side');
  side.setAttribute('aria-label', '设置分类');
  main = el('div', 'bncm-set-main');
  for (const g of GROUPS) {
    const tab = button('bncm-set-tab', `${ICONS[g.id]}<span>${g.tab || g.label}</span>`);
    tab.dataset.g = g.id;
    tab.addEventListener('click', () => jumpTo(g.id));
    side.append(tab);

    const page = el('section', 'bncm-set-page');
    page.dataset.g = g.id;
    page.setAttribute('aria-label', g.label);
    page.append(el('h2', 'bncm-set-title', g.label));
    for (const sec of g.sections) {
      const wrap = el('div', 'bncm-set-section');
      if (sec.title) wrap.append(el('div', 'bncm-set-head', sec.title));
      const card = el('div', 'bncm-set-card');
      for (const r of sec.rows) {
        const row = BUILDERS[r.type](r);
        if (r.when) syncs.push((s) => { row.hidden = !r.when(s); });
        card.append(row);
      }
      wrap.append(card);
      if (sec.when) syncs.push((s) => { wrap.hidden = !sec.when(s); });
      page.append(wrap);
    }
    main.append(page);
  }
  root.append(side, main);
  // clicks inside never reach the page under the popover
  root.addEventListener('pointerdown', (e) => e.stopPropagation());
  // main.js ignores keys typed into inputs (a focused slider too) and turns Space into play/pause;
  // inside the popover Esc closes it from any control and Space activates the focused control
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSettings(); }
    else if (e.key === ' ' && e.target instanceof Element && e.target.closest('button, input')) e.stopPropagation();
  });
  document.body.append(root);
  main.addEventListener('scroll', () => { if (performance.now() > jumpUntil) markGroup(groupAtScroll()); }, { passive: true });
  markGroup(groupId);
  watch('settings', (s) => { if (isOpen) sync(s); });
  // the switches' 当前歌曲没有… follow the track
  watch('lyrics', () => { if (isOpen) sync(); });
}

function sync(s = S()) {
  for (const fn of syncs) {
    try { fn(s); } catch (e) { console.error('settings row failed', e); }
  }
}

function markGroup(id) {
  groupId = id;
  for (const t of side.children) {
    const on = t.dataset.g === id;
    t.classList.toggle('on', on);
    if (on) t.setAttribute('aria-current', 'true'); else t.removeAttribute('aria-current');
    // a bar too narrow for every tab scrolls the marked one into view
    if (on && side.scrollWidth > side.clientWidth) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

// A group's top in the column's scroll coordinates.
function pageTop(page) {
  return page.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
}

/** The group filling the column's upper third; at the very bottom, the last one (it may be too short to reach the top). */
function groupAtScroll() {
  const pages = [...main.children];
  if (main.scrollTop + main.clientHeight >= main.scrollHeight - 2) return pages.at(-1).dataset.g;
  let id = pages[0].dataset.g;
  for (const p of pages) if (pageTop(p) <= main.scrollTop + main.clientHeight / 3) id = p.dataset.g;
  return id;
}

function jumpTo(id) {
  const page = [...main.children].find((p) => p.dataset.g === id);
  if (!page) return;
  markGroup(id);
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  jumpUntil = smooth ? performance.now() + 700 : 0;
  main.scrollTo({ top: page === main.firstElementChild ? 0 : pageTop(page) - 6, behavior: smooth ? 'smooth' : 'auto' });
}

function onOutside(e) {
  if (!isOpen || root.contains(e.target)) return;
  // the settings button toggles by itself (tools.js)
  if (e.target.closest?.('.bncm-top-settings')) return;
  // a click that only dismisses should not also seek the lyrics or act in a panel
  if (e.target.closest?.('.rnp-lyrics, .bncm-panel-host')) {
    document.addEventListener('click', swallowClick, true);
    swallowTimer = setTimeout(() => document.removeEventListener('click', swallowClick, true), 1500);
  }
  closeSettings();
}
function swallowClick(e) {
  document.removeEventListener('click', swallowClick, true);
  clearTimeout(swallowTimer);
  e.stopPropagation();
  e.preventDefault();
}
function onEscape(e) {
  if (!isOpen) return;
  e.preventDefault();
  closeSettings();
}

function openSettings() {
  if (!root) build();
  if (isOpen) return;
  isOpen = true;
  sync();
  root.hidden = false;
  void root.offsetWidth; // start the transition from the closed state
  root.classList.add('open');
  document.body.classList.add('bncm-settings-open');
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('bncm-escape', onEscape);
}

export function closeSettings() {
  if (!isOpen) return;
  isOpen = false;
  root.classList.remove('open');
  document.body.classList.remove('bncm-settings-open');
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('bncm-escape', onEscape);
  if (root.contains(document.activeElement)) document.activeElement.blur();
  // display:none once faded, so the closed popover (and its backdrop blur) costs nothing
  setTimeout(() => { if (!isOpen) root.hidden = true; }, 220);
  sync();
  document.dispatchEvent(new CustomEvent('bncm-settings-closed'));
}

/** Opens or closes the popover; returns whether it is open now. */
export function toggleSettings() {
  if (isOpen) closeSettings(); else openSettings();
  return isOpen;
}
