// The "···" menu beside the song info: the items of NCM's play-bar menu that make sense here, drawn
// like compat-rnp-menu-style.js drew NCM's own menu on RNPN's page (Apple-like: translucent material
// tinted with the cover's colour, text only, 28px rows). NCM's side is lyrics-actions-menu.js.
// 收藏到歌单 / 下载 / 分享 open NCM's own dialogs, so the window collapses first and NCM shows them.
import { host, request } from './bus.js';
import { state, watch } from './state.js';

const GAP = 8; // between the button and the menu, and the menu and the window's edges
const SUB_DELAY_MS = 120; // hover before the speed submenu opens
const SUB_CLOSE_MS = 250; // grace for a pointer on its way into the submenu
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const CHEVRON = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 1.8 6.7 5 3.5 8.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHECK = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.4 6.3 4.9 8.7 9.6 3.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let cssReady = null;
let cssLoaded = false;
/** menu.css also styles the toast and the copy mode (copy-mode.js). Resolves once it applies. */
export function loadMenuCss() {
  if (cssReady) return cssReady;
  cssReady = new Promise((resolve) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'css/menu.css';
    l.onload = l.onerror = () => { cssLoaded = true; resolve(); };
    document.head.append(l);
  });
  return cssReady;
}

let open = null; // {el, anchor, items, sub, collapse, ...}
let speed = { value: 1, shown: true }; // the last answer from NCM; refreshed on every open

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const validId = (id) => !!id && id !== '0' && /^\d+$/.test(String(id));
const speedText = (v) => (v === 1 ? '正常' : `${v}×`);

function action(name, fields = {}) {
  return request('ncmAction', { action: name, ...fields }, 8000);
}

// --- items -------------------------------------------------------------------------------------
function buildItems(collapse) {
  const t = state.track || {};
  const online = validId(t.id) && !t.local;
  // the dialogs show in NCM's window: hand the screen back to NCM first
  const inNcm = (what) => () => { collapse(); action('menuRun', { what }).catch((e) => console.error('menu', what, e)); };
  const items = [
    { label: '收藏到歌单', disabled: !online, run: inNcm('favorite') },
    { label: '下载', disabled: !online, run: inNcm('download') },
    { label: '分享', disabled: !online, run: inNcm('share') },
    { label: '复制歌曲链接', disabled: !online, run: () => {
      host('copy', { text: `https://music.163.com/song?id=${t.id}` });
      toast('已复制歌曲链接');
    } },
  ];
  if (speed.shown) {
    items.push({ sep: true });
    items.push({ label: '播放倍速', detail: speed.value === 1 ? '' : `${speed.value}×`, sub: 'speed' });
  }
  items.push({ sep: true });
  const arts = t.artists?.length ? t.artists : [{ id: '', name: '未知' }];
  for (const a of arts) {
    items.push({ label: `歌手：${a.name || '未知'}`, disabled: !validId(a.id), run: () => {
      action('menuLink', { kind: 'artist', id: a.id }).catch((e) => console.error('menu link', e));
      collapse();
    } });
  }
  const al = t.album || {};
  items.push({ label: `专辑：${al.name || '未知'}`, disabled: !validId(al.id) || !al.name, run: () => {
    action('menuLink', { kind: 'album', id: al.id }).catch((e) => console.error('menu link', e));
    collapse();
  } });
  return items;
}

function speedItems() {
  return SPEEDS.map((v) => ({
    label: speedText(v), checked: Math.abs(v - speed.value) < 0.001,
    run: () => {
      speed = { ...speed, value: v };
      action('menuSpeed', { speed: v }).then((r) => { if (r && Number.isFinite(r.speed)) speed = { ...speed, value: r.speed }; })
        .catch((e) => console.error('menu speed', e));
    },
  }));
}

function render(el, items, { checks = false } = {}) {
  el.innerHTML = items.map((it, i) => (it.sep
    ? '<div class="bncm-menu-sep" role="separator"></div>'
    : `<div class="bncm-menu-item${it.disabled ? ' disabled' : ''}${it.sub ? ' has-sub' : ''}" role="menuitem${checks ? 'radio' : ''}" data-i="${i}"${it.disabled ? ' aria-disabled="true"' : ''}${checks ? ` aria-checked="${!!it.checked}"` : ''}>`
      + (checks ? `<span class="bncm-menu-check">${it.checked ? CHECK : ''}</span>` : '')
      + `<span class="bncm-menu-label">${esc(it.label)}</span>`
      + (it.detail ? `<span class="bncm-menu-detail">${esc(it.detail)}</span>` : '')
      + (it.sub ? `<span class="bncm-menu-chevron">${CHEVRON}</span>` : '')
      + '</div>')).join('');
}

function makeMenu(cls = '') {
  const el = document.createElement('div');
  el.className = `bncm-menu ${cls}`.trim();
  el.setAttribute('role', 'menu');
  // the resolved accent variables are defined on body's children (RNPN's stylesheet)
  document.body.append(el);
  return el;
}

// --- open / close ----------------------------------------------------------------------------------
/** Called by side.js with the "···" button. A second click closes the menu. */
export function openMenu(anchor, { collapse }) {
  if (open) { closeMenu(); return; }
  // measured on open, so the stylesheet has to be there first
  if (!cssLoaded) { loadMenuCss().then(() => openMenu(anchor, { collapse })); return; }
  const el = makeMenu();
  open = { el, anchor, collapse, items: [], sub: null, subTimer: 0, active: -1 };
  anchor.classList.add('bncm-menu-open');
  fill();
  place(el, anchor);
  // the class after a frame so the opening transition runs from the closed state
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('shown')));
  el.addEventListener('pointermove', onPointer(open, () => open?.items), { passive: true });
  el.addEventListener('pointerleave', () => { if (open && !open.sub) setActive(open, -1); });
  el.addEventListener('click', (e) => onClick(e, false));
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('bncm-escape', onEscape);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);
  // NCM's current speed (and whether NCM offers speeds at all); the menu redraws if it differs
  action('menuInfo').then((info) => {
    if (!info || !open || open.el !== el) return;
    const next = { value: Number(info.speed) || 1, shown: info.speedShown !== false };
    if (next.value === speed.value && next.shown === speed.shown) return;
    speed = next;
    fill();
    place(el, anchor);
  }).catch(() => { /* keep the last known speed */ });
}

function fill() {
  open.items = buildItems(open.collapse);
  render(open.el, open.items);
  closeSub();
  open.active = -1;
}

export function closeMenu() {
  if (!open) return;
  const { el, anchor } = open;
  closeSub();
  clearTimeout(open.subTimer);
  open = null;
  anchor.classList.remove('bncm-menu-open');
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('bncm-escape', onEscape);
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', closeMenu);
  window.removeEventListener('resize', closeMenu);
  el.classList.remove('shown');
  el.classList.add('closing');
  el.style.pointerEvents = 'none';
  setTimeout(() => el.remove(), 160);
}

export function isMenuOpen() { return !!open; }

// Above the button, its left edge on the button's (as compat-rnp-menu.js placed NCM's), below it
// when there is no room above; it grows from the button.
function place(el, anchor) {
  const a = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const left = Math.max(GAP, Math.min(a.left, innerWidth - w - GAP));
  const above = a.top - GAP - h >= GAP;
  const top = above ? a.top - GAP - h : Math.min(a.bottom + GAP, innerHeight - h - GAP);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.transformOrigin = `${Math.round(a.left + a.width / 2 - left)}px ${above ? '100%' : '0%'}`;
}

function placeSub(sub, row) {
  const r = row.getBoundingClientRect();
  const m = row.parentElement.getBoundingClientRect();
  const w = sub.offsetWidth;
  const h = sub.offsetHeight;
  const right = m.right - 4 + w + GAP <= innerWidth;
  const left = right ? m.right - 4 : m.left + 4 - w;
  // the submenu's first row level with the row that opened it, inside the window
  const top = Math.max(GAP, Math.min(r.top - 5, innerHeight - h - GAP));
  sub.style.left = `${Math.round(Math.max(GAP, left))}px`;
  sub.style.top = `${Math.round(top)}px`;
  sub.style.transformOrigin = `${right ? '0' : '100%'} ${Math.round(r.top + r.height / 2 - top)}px`;
}

// --- submenu --------------------------------------------------------------------------------------
function openSub(i, { keyboard = false } = {}) {
  if (!open) return;
  clearTimeout(open.subTimer);
  if (open.sub?.from === i) return;
  closeSub();
  const row = open.el.querySelector(`[data-i="${i}"]`);
  if (!row) return;
  const el = makeMenu('bncm-submenu');
  const items = speedItems();
  render(el, items, { checks: true });
  const sub = { el, items, from: i, active: -1 };
  open.sub = sub;
  row.classList.add('open');
  placeSub(el, row);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('shown')));
  el.addEventListener('pointermove', onPointer(sub, () => sub.items), { passive: true });
  el.addEventListener('pointerenter', () => { if (open) { clearTimeout(open.subTimer); setActive(open, i); } });
  el.addEventListener('pointerleave', () => setActive(sub, -1));
  el.addEventListener('click', (e) => onClick(e, true));
  if (keyboard) setActive(sub, Math.max(0, items.findIndex((it) => it.checked)));
}

function closeSub() {
  const sub = open?.sub;
  if (!sub) return;
  open.sub = null;
  open.el.querySelector('.bncm-menu-item.open')?.classList.remove('open');
  sub.el.remove();
}

// --- pointer and keys --------------------------------------------------------------------------------
function setActive(menu, i) {
  if (menu.active === i) return;
  menu.el.querySelector('.bncm-menu-item.active')?.classList.remove('active');
  menu.active = i;
  if (i >= 0) menu.el.querySelector(`[data-i="${i}"]`)?.classList.add('active');
}

function onPointer(menu, items) {
  return (e) => {
    if (!open) return;
    const row = e.target.closest('.bncm-menu-item');
    const i = row && !row.classList.contains('disabled') ? Number(row.dataset.i) : -1;
    if (i === menu.active) return;
    setActive(menu, i);
    if (menu !== open) return;
    clearTimeout(open.subTimer);
    const it = items()[i];
    if (it?.sub) open.subTimer = setTimeout(() => openSub(i), SUB_DELAY_MS);
    else if (open.sub) open.subTimer = setTimeout(closeSub, SUB_CLOSE_MS);
  };
}

function onClick(e, inSub) {
  if (!open) return;
  const row = e.target.closest('.bncm-menu-item');
  if (!row || row.classList.contains('disabled')) return;
  const i = Number(row.dataset.i);
  const it = (inSub ? open.sub?.items : open.items)?.[i];
  if (!it) return;
  if (it.sub) { openSub(i, { keyboard: e.detail === 0 }); return; }
  closeMenu();
  it.run?.();
}

function onOutside(e) {
  if (!open) return;
  const t = e.target;
  if (open.el.contains(t) || open.sub?.el.contains(t)) return;
  // the "···" button toggles the menu itself
  if (open.anchor.contains(t)) return;
  closeMenu();
}

function onEscape(e) {
  if (!open) return;
  e.preventDefault();
  if (open.sub) closeSub(); else closeMenu();
}

function step(menu, dir) {
  const n = menu.items.length;
  let i = menu.active < 0 ? (dir > 0 ? -1 : n) : menu.active;
  for (let k = 0; k < n; k++) {
    i = (i + dir + n) % n;
    const it = menu.items[i];
    if (!it.sep && !it.disabled) { setActive(menu, i); return; }
  }
}

function onKey(e) {
  if (!open) return;
  const menu = open.sub || open;
  const it = menu.items[menu.active];
  let handled = true;
  switch (e.key) {
    case 'ArrowDown': step(menu, 1); break;
    case 'ArrowUp': step(menu, -1); break;
    case 'ArrowRight': if (!open.sub && it?.sub) openSub(menu.active, { keyboard: true }); break;
    case 'ArrowLeft': if (open.sub) closeSub(); break;
    case 'Enter':
    case ' ':
      if (!it) { handled = e.key === ' '; break; }
      if (it.sub) { openSub(menu.active, { keyboard: true }); break; }
      closeMenu();
      it.run?.();
      break;
    case 'Tab': step(menu, e.shiftKey ? -1 : 1); break;
    default: handled = false;
  }
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}

// A new song while the menu is open: its artists and album are stale.
watch('track', (t, old) => { if (open && t?.id !== old?.id) closeMenu(); });

// --- toast -------------------------------------------------------------------------------------------
let toastEl = null;
let toastTimer = 0;
/** A short confirmation at the bottom of the window (also used by copy-mode.js). */
export function toast(text) {
  loadMenuCss();
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'bncm-toast';
    toastEl.setAttribute('role', 'status');
    document.body.append(toastEl);
  }
  toastEl.textContent = text;
  clearTimeout(toastTimer);
  requestAnimationFrame(() => toastEl.classList.add('shown'));
  toastTimer = setTimeout(() => toastEl.classList.remove('shown'), 1600);
}
