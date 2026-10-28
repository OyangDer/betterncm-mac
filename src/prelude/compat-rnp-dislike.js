// A "减少推荐" (dislike) button on RefinedNowPlayingNext's controls while roaming (漫游).
//
// NCM's roaming play bar has the dislike button right after "next", and RNPN's page covers that
// bar. While NCM shows its dislike button (only when roaming), RNPN's playlist button, which a
// roaming queue has little use for, gives its place to one in RNPN's own button style; a click
// on it clicks NCM's, so NCM does the rest (skip and train the recommendations). Outside roaming
// RNPN's row is left as it is. The button goes at the end of RNPN's row, after React's own
// children, so React's reconciling of them is not disturbed; a cheap check puts it back when RNPN
// re-renders the row.

const STYLE_ID = 'bncm-compat-rnp-dislike';
const BTN_CLASS = 'bncm-rnp-dislike';
const ROAMING = 'bncm-roaming';
const NATIVE = 'footer [data-testid="tid_fmdislike_btn"]';
const CONTROLS = '#rnp-view .am-music-controls';
const CHECK_MS = 1000;

const CSS = `
body.${ROAMING} ${CONTROLS} .rnp-amll-playlist { display: none !important; }
body:not(.${ROAMING}) ${CONTROLS} .${BTN_CLASS} { display: none !important; }
${CONTROLS} .${BTN_CLASS} svg { width: 22px; height: 22px; }
`;

function install() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);
}

// NCM's own icon, without its clip path (an id that would be duplicated in the document).
function iconFrom(native) {
  const svg = native.querySelector('svg')?.cloneNode(true);
  if (!svg) return null;
  svg.querySelectorAll('defs').forEach((d) => d.remove());
  svg.querySelectorAll('[clip-path]').forEach((g) => g.removeAttribute('clip-path'));
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  return svg;
}

function makeButton(native) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `am-music-track-btn ${BTN_CLASS}`;
  btn.title = '减少推荐';
  btn.setAttribute('aria-label', '减少推荐');
  const icon = iconFrom(native);
  if (icon) btn.appendChild(icon);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelector(NATIVE)?.click();
  });
  return btn;
}

function sync() {
  const native = document.querySelector(NATIVE);
  document.body.classList.toggle(ROAMING, !!native);
  if (!native) return;
  const controls = document.querySelector(CONTROLS);
  if (!controls || controls.lastElementChild?.classList.contains(BTN_CLASS)) return;
  controls.querySelector(`.${BTN_CLASS}`)?.remove();
  controls.appendChild(makeButton(native));
}

function start() {
  install();
  sync();
  setInterval(sync, CHECK_MS);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
