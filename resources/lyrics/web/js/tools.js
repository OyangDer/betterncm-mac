// The top-right tool row (text colour, settings and the collapse chevron, in RNPN's row; copy mode is in 设置)
// and the views switcher (歌词 / 百科 / 相似推荐 / 评论 / 播放列表, from compat-rnp-panels.js). The
// switcher sits in the playback controls, where RNPN's playlist button was, and opens rightward
// (upward when the lyric column leaves no room); with the controls hidden it goes back to the top
// row, where it opens leftward.
import { host } from './bus.js';
import { state, set, watch } from './state.js';

const BTN = 28;
const GAP = 4;
const RIM = 3;
const HOVER_INTENT_MS = 120;
const LEAVE_GRACE_MS = 300; // the pointer may leave the open capsule this long before it folds
const svg = (inner) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
export const VIEWS = [
  { id: 'lyrics', label: '歌词', icon: svg('<path d="M4.5 4h11A1.5 1.5 0 0 1 17 5.5v7a1.5 1.5 0 0 1-1.5 1.5H10l-3.6 2.8V14H4.5A1.5 1.5 0 0 1 3 12.5v-7A1.5 1.5 0 0 1 4.5 4z"/><path d="M7.6 7.4v1.4c0 .9-.4 1.5-1.1 1.8M11.6 7.4v1.4c0 .9-.4 1.5-1.1 1.8" stroke-width="1.7"/>') },
  { id: 'baike', label: '百科', icon: svg('<circle cx="10" cy="10" r="7"/><path d="M10 9v4.5"/><circle cx="10" cy="6.4" r=".4" fill="currentColor"/>') },
  { id: 'similar', label: '相似推荐', icon: svg('<rect x="3" y="7.5" width="10" height="9" rx="1.8"/><path d="M6 5h8.2A1.8 1.8 0 0 1 16 6.8V14"/><path d="M8.5 15V10.3l3-.8V14"/>') },
  { id: 'comment', label: '评论', icon: svg('<path d="M3 5.3A1.3 1.3 0 0 1 4.3 4h7.4A1.3 1.3 0 0 1 13 5.3v4.4A1.3 1.3 0 0 1 11.7 11H7.5L5 13v-2h-.7A1.3 1.3 0 0 1 3 9.7z"/><path d="M15 8h.7A1.3 1.3 0 0 1 17 9.3v4.4a1.3 1.3 0 0 1-1.3 1.3H15v2l-2.5-2H9.3A1.3 1.3 0 0 1 8 13.7V13"/>') },
  // RNPN's playlist icon
  { id: 'playlist', label: '播放列表', icon: '<svg viewBox="0 0 28 28" fill="currentColor"><path d="M6.25 8.2C6.25 7.7582 6.6082 7.4 7.05 7.4H18.95C19.3918 7.4 19.75 7.7582 19.75 8.2C19.75 8.6418 19.3918 9 18.95 9H7.05C6.6082 9 6.25 8.6418 6.25 8.2ZM6.25 14C6.25 13.5582 6.6082 13.2 7.05 13.2H18.95C19.3918 13.2 19.75 13.5582 19.75 14C19.75 14.4418 19.3918 14.8 18.95 14.8H7.05C6.6082 14.8 6.25 14.4418 6.25 14ZM6.25 19.8C6.25 19.3582 6.6082 19 7.05 19H14.95C15.3918 19 15.75 19.3582 15.75 19.8C15.75 20.2418 15.3918 20.6 14.95 20.6H7.05C6.6082 20.6 6.25 20.2418 6.25 19.8ZM21.1 17.0899C20.7548 16.8601 20.3 17.1076 20.3 17.5222V22.4778C20.3 22.8924 20.7548 23.1399 21.1 22.9101L24.8167 20.4323C25.1252 20.2266 25.1252 19.7734 24.8167 19.5677L21.1 17.0899Z"/></svg>' },
];

let switcher;
let topSlot = null; // where the switcher sits in the top row
let bottomSlot = null; // RNPN's playlist button, which it replaces in the controls
let held = false;
let openTimer = 0;
let closeTimer = 0;

async function lazy(path, fn, ...args) {
  try {
    const m = await import(path);
    return m[fn]?.(...args);
  } catch (e) {
    console.error(`${path} unavailable`, e);
    return undefined;
  }
}

export function mountTools({ collapse }) {
  const tools = document.querySelector('#rnp-view .rnp-window-tools');
  tools.querySelector('.rnp-window-tool-plugin-close')?.addEventListener('click', (e) => { e.stopPropagation(); collapse(); });
  const settingsBtn = tools.querySelector('.bncm-top-settings');
  settingsBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const open = await lazy('./settings-ui.js', 'toggleSettings');
    settingsBtn.classList.toggle('bncm-on', !!open);
  });
  document.addEventListener('bncm-settings-closed', () => settingsBtn?.classList.remove('bncm-on'));

  // 文字颜色 in one click: white and black text swap (from 跟随系统, to the opposite of what shows)
  const schemeBtn = tools.querySelector('.bncm-top-scheme');
  schemeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    lazy('./settings.js', 'update', { scheme: state.scheme === 'dark' ? 'light' : 'dark' });
  });
  const schemeTip = (v) => {
    const tip = v === 'dark' ? '文字颜色：白色（点按换成黑色）' : '文字颜色：黑色（点按换成白色）';
    schemeBtn?.setAttribute('title', tip);
    schemeBtn?.setAttribute('aria-label', tip);
  };
  schemeTip(state.scheme);
  watch('scheme', schemeTip);

  switcher = tools.querySelector('#bncm-rnp-views');
  for (const v of VIEWS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.view = v.id;
    b.title = v.label;
    b.setAttribute('aria-label', v.label);
    b.innerHTML = v.icon;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      clearTimeout(openTimer);
      if (!switcher.classList.contains('bncm-open') || v.id === state.view) {
        openSwitcher();
        held = false;
        return;
      }
      switcher.classList.remove('bncm-open');
      held = true;
      set('view', v.id);
    });
    switcher.append(b);
  }
  const armOpen = () => {
    clearTimeout(openTimer);
    openTimer = setTimeout(() => { if (!held && switcher.matches(':hover')) openSwitcher(); }, HOVER_INTENT_MS);
  };
  switcher.addEventListener('mouseenter', () => { clearTimeout(closeTimer); if (!held) armOpen(); });
  switcher.addEventListener('mousemove', () => { clearTimeout(closeTimer); if (!held && !switcher.classList.contains('bncm-open')) armOpen(); });
  switcher.addEventListener('mouseleave', () => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { held = false; switcher.classList.remove('bncm-open'); }, LEAVE_GRACE_MS);
  });
  watch('view', (v) => { renderSwitcher(); lazy('./panels/index.js', 'showView', v); });
  watch('track', renderSwitcher);
  topSlot = { parent: switcher.parentElement, next: switcher.nextSibling };
  bottomSlot = document.querySelector('#rnp-view .am-music-controls .rnp-amll-playlist');
  placeSwitcher();
  watch('settings', placeSwitcher);
  // the row's left edge follows the window's width (RNPN's padding is in vw)
  window.addEventListener('resize', reportDragClear);
  watch('window', reportDragClear);
}

// In the playback controls while they show, else back in the top row.
function placeSwitcher() {
  if (!switcher) return;
  const bottom = !!bottomSlot && state.settings?.showControls !== false;
  if (bottom && switcher.parentElement !== bottomSlot.parentElement) {
    bottomSlot.before(switcher);
    bottomSlot.hidden = true;
  } else if (!bottom && switcher.parentElement !== topSlot.parent) {
    topSlot.parent.insertBefore(switcher, topSlot.next);
    if (bottomSlot) bottomSlot.hidden = false;
  }
  switcher.classList.toggle('bncm-views-bottom', bottom);
  renderSwitcher();
}

// Opens the capsule; in the controls rightward, or upward when that would run into the lyrics.
function openSwitcher() {
  if (switcher.classList.contains('bncm-views-bottom')) {
    const open = parseFloat(switcher.style.getPropertyValue('--bncm-views-open-width')) || BTN;
    const r = switcher.getBoundingClientRect();
    const col = document.querySelector('#rnp-view .lyric')?.getBoundingClientRect();
    const limit = Math.min(innerWidth - 12, col?.width ? col.left + 24 : innerWidth);
    switcher.classList.toggle('bncm-views-up', r.left + open + RIM > limit);
  }
  switcher.classList.add('bncm-open');
}

// The current view stays on the button; the others line up beside it in a fixed order (leftward in
// the top row, rightward or upward in the controls).
function renderSwitcher() {
  if (!switcher) return;
  const avail = (id) => id === 'lyrics' || id === 'playlist' || (state.track?.id && !state.track.local && (id !== 'comment' || state.track.threadId));
  // the current view keeps its button even when this track has no such panel (it shows its empty state)
  const shown = VIEWS.filter((v) => avail(v.id) || v.id === state.view);
  const rest = shown.filter((v) => v.id !== state.view);
  for (const b of switcher.querySelectorAll('button')) {
    const id = b.dataset.view;
    const visible = shown.some((v) => v.id === id);
    b.hidden = !visible;
    b.setAttribute('aria-pressed', String(id === state.view));
    const bottom = switcher.classList.contains('bncm-views-bottom');
    const at = rest.findIndex((v) => v.id === id);
    const slot = id === state.view ? 0 : bottom ? at + 1 : rest.length - at;
    b.style.setProperty('--slot', String(slot));
  }
  const n = shown.length;
  switcher.style.setProperty('--bncm-views-open-width', `${n * BTN + (n - 1) * GAP}px`);
  void RIM;
  reportDragClear();
}

// The host lays a native drag strip over the window's top 40 px; the tool row must stay out of it,
// including the switcher opened leftward (a real click there would move the window instead).
let dragClear = -1;
export function reportDragClear() {
  const tools = document.querySelector('#rnp-view .rnp-window-tools');
  if (!tools || !switcher) return;
  const inRow = tools.contains(switcher);
  const open = inRow ? parseFloat(switcher.style.getPropertyValue('--bncm-views-open-width')) || BTN : BTN;
  const left = tools.getBoundingClientRect().left - (open - BTN) - 12;
  const right = Math.ceil(Math.max(0, innerWidth - left));
  if (right === dragClear) return;
  dragClear = right;
  host('dragClear', { right });
}
