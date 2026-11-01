// The top-right tool row: the views switcher (歌词 / 百科 / 相似推荐 / 评论, from
// compat-rnp-panels.js), settings, copy mode and the collapse chevron, in RNPN's row.
import { state, set, watch } from './state.js';

const BTN = 28;
const GAP = 4;
const RIM = 3;
const HOVER_INTENT_MS = 120;
const svg = (inner) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
export const VIEWS = [
  { id: 'lyrics', label: '歌词', icon: svg('<path d="M4.5 4h11A1.5 1.5 0 0 1 17 5.5v7a1.5 1.5 0 0 1-1.5 1.5H10l-3.6 2.8V14H4.5A1.5 1.5 0 0 1 3 12.5v-7A1.5 1.5 0 0 1 4.5 4z"/><path d="M7.6 7.4v1.4c0 .9-.4 1.5-1.1 1.8M11.6 7.4v1.4c0 .9-.4 1.5-1.1 1.8" stroke-width="1.7"/>') },
  { id: 'baike', label: '百科', icon: svg('<circle cx="10" cy="10" r="7"/><path d="M10 9v4.5"/><circle cx="10" cy="6.4" r=".4" fill="currentColor"/>') },
  { id: 'similar', label: '相似推荐', icon: svg('<rect x="3" y="7.5" width="10" height="9" rx="1.8"/><path d="M6 5h8.2A1.8 1.8 0 0 1 16 6.8V14"/><path d="M8.5 15V10.3l3-.8V14"/>') },
  { id: 'comment', label: '评论', icon: svg('<path d="M3 5.3A1.3 1.3 0 0 1 4.3 4h7.4A1.3 1.3 0 0 1 13 5.3v4.4A1.3 1.3 0 0 1 11.7 11H7.5L5 13v-2h-.7A1.3 1.3 0 0 1 3 9.7z"/><path d="M15 8h.7A1.3 1.3 0 0 1 17 9.3v4.4a1.3 1.3 0 0 1-1.3 1.3H15v2l-2.5-2H9.3A1.3 1.3 0 0 1 8 13.7V13"/>') },
];

let switcher;
let held = false;
let openTimer = 0;

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
  const copyBtn = tools.querySelector('.bncm-top-copy');
  copyBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const on = await lazy('./copy-mode.js', 'toggleCopyMode');
    copyBtn.classList.toggle('bncm-on', !!on);
  });

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
        switcher.classList.add('bncm-open');
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
    openTimer = setTimeout(() => { if (!held && switcher.matches(':hover')) switcher.classList.add('bncm-open'); }, HOVER_INTENT_MS);
  };
  switcher.addEventListener('mouseenter', () => { if (!held) armOpen(); });
  switcher.addEventListener('mousemove', () => { if (!held && !switcher.classList.contains('bncm-open')) armOpen(); });
  switcher.addEventListener('mouseleave', () => { clearTimeout(openTimer); held = false; switcher.classList.remove('bncm-open'); });
  watch('view', (v) => { renderSwitcher(); lazy('./panels/index.js', 'showView', v); });
  watch('track', renderSwitcher);
  renderSwitcher();
}

// The current view sits at the right end; the others line up to its left in a fixed order.
function renderSwitcher() {
  if (!switcher) return;
  const avail = (id) => id === 'lyrics' || (state.track?.id && !state.track.local && (id !== 'comment' || state.track.threadId));
  // the current view keeps its button even when this track has no such panel (it shows its empty state)
  const shown = VIEWS.filter((v) => avail(v.id) || v.id === state.view);
  const rest = shown.filter((v) => v.id !== state.view);
  for (const b of switcher.querySelectorAll('button')) {
    const id = b.dataset.view;
    const visible = shown.some((v) => v.id === id);
    b.hidden = !visible;
    b.setAttribute('aria-pressed', String(id === state.view));
    const slot = id === state.view ? 0 : rest.length - rest.findIndex((v) => v.id === id);
    b.style.setProperty('--slot', String(slot));
  }
  const n = shown.length;
  switcher.style.setProperty('--bncm-views-open-width', `${n * BTN + (n - 1) * GAP}px`);
  void RIM;
}
