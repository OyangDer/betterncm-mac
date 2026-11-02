// 插件: a button in NCM's title-bar icon row (next to its settings button) that opens a small
// panel: each installed plugin with an on/off switch, and 卸载 BetterNCM. Switches take effect
// when the panel closes (the page reloads once); the server keeps them in disable_list.txt
// (src/plugins.mjs). Not titled "BetterNCM": hide-plugin-manager.js hides that button.

const fetchFn = window.fetch.bind(window); // before page scripts can patch it
const SETTINGS = '[data-testid=tid_header_setting_btn], .cmd-icon-setting, a[href="#/m/setting/"]';
const BTN_CLASS = 'bncm-plugins-btn';
const STYLE_ID = 'bncm-plugins-style';
const CHECK_MS = 1000;
const ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M9.5 4.5a2 2 0 0 1 4 0V6H17a1 1 0 0 1 1 1v3.5h-1.5a2 2 0 0 0 0 4H18V18a1 1 0 0 1-1 1h-3.5v-1.5a2 2 0 0 0-4 0V19H6a1 1 0 0 1-1-1v-3.5h1.5a2 2 0 0 0 0-4H5V7a1 1 0 0 1 1-1h3.5z"/></svg>';

const api = (route, opts = {}) => fetchFn(BETTERNCM_API_PATH + route, {
  ...opts,
  headers: { BETTERNCM_API_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});

const CSS = `
.${BTN_CLASS} { cursor: pointer; }
.${BTN_CLASS} svg { display: block; }
.bncm-plugins {
  --fg: 30, 30, 34; --bg: 255, 255, 255; --sub: rgba(var(--fg), .55); --line: rgba(var(--fg), .09);
  --accent: 236, 65, 65;
  position: fixed; z-index: 100000; width: 320px; max-height: min(480px, calc(100vh - 80px));
  display: flex; flex-direction: column; box-sizing: border-box;
  background: rgba(var(--bg), .96); color: rgb(var(--fg));
  -webkit-backdrop-filter: blur(30px) saturate(1.5); backdrop-filter: blur(30px) saturate(1.5);
  border-radius: 12px; border: .5px solid var(--line);
  box-shadow: 0 12px 36px rgba(0, 0, 0, .18), 0 0 0 .5px rgba(0, 0, 0, .08);
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; text-align: left;
  opacity: 0; transform: translateY(-4px); transition: opacity .15s ease, transform .18s ease;
  user-select: none; -webkit-user-select: none; cursor: default;
}
.bncm-plugins.open { opacity: 1; transform: none; }
.bncm-plugins.dark { --fg: 236, 236, 240; --bg: 44, 44, 50; --line: rgba(255, 255, 255, .1); box-shadow: 0 12px 36px rgba(0, 0, 0, .45), 0 0 0 .5px rgba(0, 0, 0, .5); }
.bncm-plugins * { box-sizing: border-box; }
.bncm-plugins button { font: inherit; color: inherit; background: none; border: 0; margin: 0; padding: 0; cursor: pointer; }
.bncm-plugins-head { display: flex; align-items: baseline; gap: 8px; padding: 14px 16px 8px; }
.bncm-plugins-head b { font-size: 15px; font-weight: 600; }
.bncm-plugins-head span { color: var(--sub); font-size: 11.5px; }
/* why the market is hidden: an ⓘ whose note shows on hover */
.bncm-plugins-info { position: relative; margin-left: auto; align-self: center; display: flex; color: var(--sub); }
.bncm-plugins-info svg { width: 16px; height: 16px; display: block; }
.bncm-plugins-info:hover, .bncm-plugins-info:focus-visible { color: rgb(var(--fg)); outline: none; }
.bncm-plugins-tip {
  position: absolute; top: calc(100% + 8px); right: -6px; z-index: 1; width: 260px; padding: 10px 12px;
  border-radius: 10px; background: rgb(var(--bg)); color: rgb(var(--fg)); border: .5px solid var(--line);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .18); font-size: 12px; line-height: 1.55; font-weight: 400;
  opacity: 0; visibility: hidden; transform: translateY(-2px); transition: opacity .12s ease, transform .12s ease, visibility 0s .12s;
  user-select: text; -webkit-user-select: text; cursor: text;
}
.bncm-plugins-info:hover .bncm-plugins-tip, .bncm-plugins-info:focus-within .bncm-plugins-tip {
  opacity: 1; visibility: visible; transform: none; transition: opacity .12s ease, transform .12s ease;
}
.bncm-plugins-tip code { font: 11.5px/1.4 ui-monospace, Menlo, monospace; background: rgba(var(--fg), .07); padding: 1px 4px; border-radius: 4px; word-break: break-all; }
.bncm-plugins-tip code.key { white-space: nowrap; word-break: normal; }
.bncm-plugins-list { overflow: auto; padding: 0 8px; }
.bncm-plugins-row { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 8px; }
.bncm-plugins-row:hover { background: rgba(var(--fg), .05); }
.bncm-plugins-text { flex: 1; min-width: 0; }
.bncm-plugins-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bncm-plugins-name small { color: var(--sub); font-weight: 400; margin-left: 6px; }
.bncm-plugins-sub { color: var(--sub); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bncm-plugins-empty { color: var(--sub); padding: 10px 8px 14px; }
.bncm-plugins-switch { flex: none; position: relative; width: 36px; height: 22px; border-radius: 11px; background: rgba(var(--fg), .18) !important; transition: background-color .2s ease; }
.bncm-plugins-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .25); transition: transform .2s ease; }
.bncm-plugins-switch[aria-checked="true"] { background: rgb(var(--accent)) !important; }
.bncm-plugins-switch[aria-checked="true"]::after { transform: translateX(14px); }
.bncm-plugins-switch:disabled { opacity: .4; cursor: default; }
.bncm-plugins-note { padding: 8px 16px 0; color: var(--sub); font-size: 11.5px; }
.bncm-plugins-foot { border-top: .5px solid var(--line); margin-top: 8px; padding: 6px 8px 8px; }
.bncm-plugins-uninstall { width: 100%; text-align: left !important; padding: 8px !important; border-radius: 8px; color: rgb(var(--accent)) !important; }
.bncm-plugins-uninstall:hover { background: rgba(var(--accent), .08) !important; }
.bncm-plugins-confirm { padding: 4px 8px 6px; }
.bncm-plugins-confirm p { margin: 0 0 10px; color: var(--sub); font-size: 12px; line-height: 1.5; }
.bncm-plugins-actions { display: flex; justify-content: flex-end; gap: 8px; }
.bncm-plugins-actions button { height: 28px; padding: 0 14px !important; border-radius: 14px; background: rgba(var(--fg), .08) !important; }
.bncm-plugins-actions .danger { background: rgb(var(--accent)) !important; color: #fff !important; font-weight: 500; }
`;

let panel = null;
let changed = false; // a plugin switched: reload when the panel closes
let lyricsFlips = 0; // the lyrics window switched: an odd count means BetterNCM reloads the page itself

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// NCM's theme, from its own icon colour: light icons sit on a dark title bar.
function isDark(ref) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(ref).color || '');
  if (!m) return matchMedia('(prefers-color-scheme: dark)').matches;
  return (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) > 150;
}

function row(p) {
  const r = el('div', 'bncm-plugins-row');
  const text = el('div', 'bncm-plugins-text');
  const name = el('div', 'bncm-plugins-name', p.name);
  if (p.version) name.append(el('small', null, p.version));
  text.append(name);
  const sub = p.note || [p.author && `作者 ${p.author}`, p.description].filter(Boolean).join(' · ');
  if (sub) text.append(el('div', 'bncm-plugins-sub', sub));
  if (p.description) text.title = p.description;
  const sw = el('button', 'bncm-plugins-switch');
  sw.type = 'button';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', p.name);
  sw.setAttribute('aria-checked', String(!!p.enabled));
  sw.disabled = !!p.dev;
  sw.addEventListener('click', async () => {
    const on = sw.getAttribute('aria-checked') !== 'true';
    sw.disabled = true;
    try {
      const res = await api('/internal/plugins/enabled', { method: 'POST', body: JSON.stringify({ slug: p.slug, enabled: on }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      sw.setAttribute('aria-checked', String(on));
      if (p.builtin) {
        // BetterNCM reloads the page itself once the setting is saved
        lyricsFlips++;
        const note = panel?.querySelector('.bncm-plugins-note');
        if (note) { note.textContent = '正在切换，页面马上刷新…'; note.hidden = false; }
      } else {
        changed = true;
        panel?.querySelector('.bncm-plugins-note')?.removeAttribute('hidden');
      }
    } catch (e) {
      console.warn('[BetterNCM] could not switch', p.slug, e);
    }
    sw.disabled = false;
  });
  r.append(text, sw);
  return r;
}

function uninstallPart() {
  const foot = el('div', 'bncm-plugins-foot');
  const btn = el('button', 'bncm-plugins-uninstall', '卸载 BetterNCM…');
  btn.type = 'button';
  const confirm = el('div', 'bncm-plugins-confirm');
  confirm.hidden = true;
  confirm.append(el('p', null, '网易云会关闭，再以原版重新打开，之后打开网易云也不再加载插件。插件和设置保留在数据文件夹里，重新安装后恢复。'));
  const actions = el('div', 'bncm-plugins-actions');
  const cancel = el('button', null, '取消');
  const ok = el('button', 'danger', '卸载');
  cancel.type = 'button';
  ok.type = 'button';
  actions.append(cancel, ok);
  confirm.append(actions);
  btn.addEventListener('click', () => { btn.hidden = true; confirm.hidden = false; });
  cancel.addEventListener('click', () => { btn.hidden = false; confirm.hidden = true; });
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    cancel.disabled = true;
    ok.textContent = '正在卸载…';
    try {
      const res = await api('/internal/uninstall', { method: 'POST', body: '{}' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      changed = false; // NCM is about to close; no reload
    } catch (e) {
      ok.textContent = '卸载失败';
      console.warn('[BetterNCM] uninstall failed', e);
    }
  });
  foot.append(btn, confirm);
  return foot;
}

// Most plugins in BetterNCM's market do not run on the Mac, so its manager and market are hidden;
// the note says how to bring them back (README, 插件).
function infoTip() {
  const info = el('span', 'bncm-plugins-info');
  info.tabIndex = 0;
  info.setAttribute('role', 'note');
  info.setAttribute('aria-label', '为什么没有插件市场');
  info.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.4"/><path d="M8 7.2v4" stroke-linecap="round"/><circle cx="8" cy="4.9" r=".8" fill="currentColor" stroke="none"/></svg>';
  const tip = el('div', 'bncm-plugins-tip');
  const code = (t) => el('code', null, t);
  tip.append(
    '原版 BetterNCM 插件市场里的大部分插件在 Mac 上用不了，所以这里隐藏了插件管理和插件市场。',
    el('br'), el('br'),
    '需要的话，在 ', code('~/Library/Application Support/BetterNCM-mac/config.json'),
    ' 里加上 ', Object.assign(code('"mac.pluginManager": "true"'), { className: 'key' }), '，然后退出网易云再打开。',
  );
  info.append(tip);
  return info;
}

async function openPanel(btn) {
  if (panel) return;
  changed = false;
  lyricsFlips = 0;
  panel = el('div', 'bncm-plugins');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '插件');
  if (isDark(btn)) panel.classList.add('dark');
  const head = el('div', 'bncm-plugins-head');
  const version = el('span', null, '');
  head.append(el('b', null, '插件'), version);
  const list = el('div', 'bncm-plugins-list');
  list.append(el('div', 'bncm-plugins-empty', '正在读取…'));
  const note = el('div', 'bncm-plugins-note', '关闭这个面板后，网易云页面会刷新一次，改动随之生效。');
  note.hidden = true;
  panel.append(head, list, note, uninstallPart());
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.body.append(panel);
  const r = btn.getBoundingClientRect();
  panel.style.top = `${Math.round(r.bottom + 8)}px`;
  panel.style.right = `${Math.max(8, Math.round(innerWidth - r.right - 8))}px`;
  requestAnimationFrame(() => panel?.classList.add('open'));
  setTimeout(() => panel?.classList.add('open'), 50); // rAF stalls while the window is hidden
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  try {
    const data = await (await api('/internal/plugins')).json();
    version.textContent = `BetterNCM ${data.version}`;
    if (!data.pluginManager) head.append(infoTip());
    list.textContent = '';
    if (!data.plugins.length) list.append(el('div', 'bncm-plugins-empty', '还没有安装插件。'));
    for (const p of data.plugins) list.append(row(p));
  } catch (e) {
    list.textContent = '';
    list.append(el('div', 'bncm-plugins-empty', '读取插件列表失败。'));
    console.warn('[BetterNCM] could not list plugins', e);
  }
}

function closePanel() {
  if (!panel) return;
  const p = panel;
  panel = null;
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  p.classList.remove('open');
  setTimeout(() => p.remove(), 200);
  if (changed && lyricsFlips % 2 === 0) setTimeout(() => location.reload(), 220);
}

function onOutside(e) {
  if (panel && !panel.contains(e.target) && !e.target.closest?.(`.${BTN_CLASS}`)) closePanel();
}

function onKey(e) {
  if (e.key !== 'Escape' || !panel) return;
  e.preventDefault();
  e.stopPropagation();
  closePanel();
}

// A copy of the settings button's slot in the icon row keeps NCM's spacing and hover style.
function makeButton(settings, slot) {
  const copy = slot.cloneNode(true);
  const inner = slot === settings ? copy : copy.querySelector(SETTINGS) || copy;
  for (const n of [copy, ...copy.querySelectorAll('*')]) {
    n.removeAttribute('data-testid');
    n.removeAttribute('data-log');
    n.removeAttribute('id');
    n.classList?.remove('cmd-icon-setting');
  }
  if (inner.tagName === 'A') inner.setAttribute('href', 'javascript:void(0)');
  inner.setAttribute('role', 'button');
  inner.setAttribute('title', '插件');
  inner.setAttribute('aria-label', '插件');
  inner.classList.add(BTN_CLASS);
  inner.innerHTML = ICON;
  copy.classList.add(`${BTN_CLASS}-slot`);
  inner.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (panel) closePanel(); else openPanel(inner);
  }, true);
  return copy;
}

function sync() {
  if (!document.getElementById(STYLE_ID)) {
    const style = el('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).append(style);
  }
  const settings = document.querySelector(SETTINGS);
  if (!settings) return;
  const slot = settings.closest('[class*=IconBar_] > *') || settings;
  if (slot.parentElement?.querySelector(`:scope > .${BTN_CLASS}-slot`)) return;
  slot.after(makeButton(settings, slot));
}

function start() {
  sync();
  setInterval(sync, CHECK_MS); // NCM re-renders its title bar
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
