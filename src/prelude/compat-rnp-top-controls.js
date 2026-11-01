// Top-right controls for RefinedNowPlayingNext's page (config mac.rnpAppleStyle).
//
// RNPN puts a close (×) button in a top bar that fades in only when the pointer comes near it,
// its settings (≡) toggle further down the right edge, and its lyric copy mode button at the top
// of the column of lyric switches beside the lyrics, which shows only under the pointer. Here the
// close button becomes a collapse chevron that always shows, closer to the corner (EDGE_PX from
// the top and right edges), and settings and copy mode get buttons in a row to its left that
// show while the pointer is near the row or the settings menu is open. "Near" is a hover on the
// row, padded out to the window's edges, NEAR_PX below and NEAR_LEFT_PX to the left, so the
// pointer finds the buttons before it reaches them; CSS only, no pointer tracking.
//
// Those two buttons click RNPN's own, which stay where RNPN rendered them, hidden: the settings
// toggle is a checkbox that opens its menu through a `:checked +` sibling rule, and the switch
// column is RNPN's rendering. The new buttons go at the end of RNPN's tool row and are put first
// with `order`, and a cheap check puts them back when RNPN renders the row again.

const STYLE_ID = 'bncm-compat-rnp-top-controls';
const TOOLS = '#rnp-view .rnp-window-tools';
const CLOSE = '.rnp-window-tool-plugin-close';
const SETTINGS = '#rnp-settings';
const COPY_MODE = '#rnp-view .rnp-lyrics-switch-btn-overview-mode';
const TOOL_CLASS = 'bncm-top-tool';
const SETTINGS_CLASS = 'bncm-top-settings';
const COPY_CLASS = 'bncm-top-copy';
const ON = 'bncm-on';
const COLLAPSE_TITLE = '收起';
const EDGE_PX = 14; // RNPN's top bar padding is 14px at the top and up to 48px at the right
const NEAR_PX = 20;
const NEAR_LEFT_PX = 40;
const CHECK_MS = 1000;

const CHEVRON = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4.5 7.5l5.5 5.5 5.5-5.5'/%3E%3C/svg%3E\")";
const SLIDERS_SVG = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 5.5h14M3 10h14M3 14.5h14"/><circle cx="7" cy="5.5" r="2" fill="currentColor" stroke="none"/><circle cx="13" cy="10" r="2" fill="currentColor" stroke="none"/><circle cx="8.5" cy="14.5" r="2" fill="currentColor" stroke="none"/></svg>';
// RNPN's copy mode icon
const LINES_SVG = '<svg viewBox="2 2 16 16" fill="currentColor"><path d="M4.146 14.854v-1.396h6.792v1.396Zm0-2.937v-1.396h11.729v1.396Zm0-2.959V7.562h11.729v1.396Zm0-2.937V4.625h11.729v1.396Z"/></svg>';

const CSS = `
#rnp-view .rnp-window-topbar { padding-right: ${EDGE_PX}px; }
${TOOLS} {
  /* up to the window's top and right edges, and NEAR_PX / NEAR_LEFT_PX out into the page */
  padding: ${EDGE_PX}px ${EDGE_PX}px ${NEAR_PX}px ${NEAR_LEFT_PX}px;
  margin: -${EDGE_PX}px -${EDGE_PX}px -${NEAR_PX}px -${NEAR_LEFT_PX}px;
  opacity: 1 !important;
  transform: none !important;
  pointer-events: auto !important;
  gap: 6px;
}
/* Bare icons like the rest of the page; a tint only under the pointer. */
${TOOLS} .rnp-window-tool {
  width: 28px;
  height: 28px;
  border-radius: 50%; /* round, like every icon button on the page */
  background: transparent;
  box-shadow: none;
  backdrop-filter: none;
  color: rgb(var(--rnp-accent-color-shade-2-rgb));
}
/* On the icon rather than in the color, so the slider knobs do not darken where they overlap. */
${TOOLS} .rnp-window-tool > svg, ${TOOLS} .rnp-window-tool::before { opacity: 0.72; }
${TOOLS} .rnp-window-tool:hover { background: rgba(var(--rnp-accent-color-shade-2-rgb), 0.1); transform: none; }
${TOOLS} ${CLOSE}::before {
  width: 18px;
  height: 18px;
  transform: none;
  border-radius: 0;
  -webkit-mask: ${CHEVRON} center / contain no-repeat;
}
${TOOLS} ${CLOSE}::after { display: none; }
${TOOLS} .${TOOL_CLASS} { order: -1; }
${TOOLS} .${TOOL_CLASS}::before, ${TOOLS} .${TOOL_CLASS}::after { display: none; }
${TOOLS} .${TOOL_CLASS} svg { width: 18px; height: 18px; }
${TOOLS} .${TOOL_CLASS}[hidden] { display: none; }
${TOOLS} .${TOOL_CLASS}.${ON} { background: rgba(var(--rnp-accent-color-shade-2-rgb), 0.16); }
${TOOLS}:not(:hover) .${TOOL_CLASS}:not(.${SETTINGS_CLASS}.${ON}) { opacity: 0; pointer-events: none; }
${SETTINGS} { display: none !important; }
.rnp-settings-menu { top: 56px !important; right: ${EDGE_PX}px !important; }
${COPY_MODE} { visibility: hidden !important; pointer-events: none !important; }
`;

function install() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);
}

function makeButton(cls, title, svg, target) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `rnp-window-tool ${TOOL_CLASS} ${cls}`;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML = svg;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelector(target)?.click();
    setTimeout(sync, 0);
  });
  return btn;
}

function sync() {
  const tools = document.querySelector(TOOLS);
  if (!tools) return;
  const close = tools.querySelector(CLOSE);
  if (close && close.title !== COLLAPSE_TITLE) {
    close.title = COLLAPSE_TITLE;
    close.setAttribute('aria-label', COLLAPSE_TITLE);
  }
  let settings = tools.querySelector(`.${SETTINGS_CLASS}`);
  let copy = tools.querySelector(`.${COPY_CLASS}`);
  if (!settings) settings = tools.appendChild(makeButton(SETTINGS_CLASS, '设置', SLIDERS_SVG, SETTINGS));
  if (!copy) copy = tools.appendChild(makeButton(COPY_CLASS, '复制模式', LINES_SVG, COPY_MODE));
  const input = document.querySelector(SETTINGS);
  const copyMode = document.querySelector(COPY_MODE);
  settings.hidden = !input;
  settings.classList.toggle(ON, !!input?.checked);
  copy.hidden = !copyMode;
  copy.classList.toggle(ON, !!copyMode?.classList.contains('active'));
}

function start() {
  install();
  sync();
  document.addEventListener('change', (e) => { if (e.target?.id === 'rnp-settings') sync(); }, true);
  setInterval(sync, CHECK_MS);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
