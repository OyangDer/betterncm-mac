// Layout tweaks for RefinedNowPlayingNext's built-in player controls.
//
// The full-width volume slider row under the transport buttons becomes a small speaker button
// beside the song info's "···" (more) button, drawn in the same style. Hovering it widens it to
// the left into a pill holding the slider, with the speaker staying put at the right end. Taking
// the row out of the flow also lets the bottom-aligned cover and controls block sit lower.
//
// The volume control stays where RNPN rendered it in the DOM (moving nodes RNPN owns would
// fight its rendering); it is positioned against .mn, the column holding both the song info and
// the controls, at the offsets measured from the more button.

const STYLE_ID = 'bncm-compat-rnp-layout';
const BTN_CLASS = 'bncm-vol-btn';
const SIZE = 30; // matches .rnp-info-more-button
const GAP = 8;
const OPEN_WIDTH = 170;
const MN = '#rnp-view .g-single-track .g-singlec-ct .n-single .mn';

const CSS = `
${MN} { position: relative; }
#rnp-view .am-music-volume-controls {
  position: absolute;
  top: var(--bncm-vol-top, 0px);
  right: var(--bncm-vol-right, ${SIZE + GAP}px);
  width: ${SIZE}px !important; /* RNPN sizes the volume row with a more specific rule */
  height: ${SIZE}px;
  border-radius: 10px;
  overflow: hidden;
  background: rgba(var(--rnp-accent-color-shade-2-rgb), 0.08);
  color: rgba(var(--rnp-accent-color-shade-2-rgb), 0.72);
  transition: width 0.24s cubic-bezier(0.2, 0.8, 0.2, 1), background-color 0.2s ease, color 0.2s ease;
}
#rnp-view .am-music-volume-controls:hover {
  width: ${OPEN_WIDTH}px !important;
  background: rgba(var(--rnp-accent-color-shade-2-rgb), 0.14);
  color: rgba(var(--rnp-accent-color-shade-2-rgb), 0.96);
}
#rnp-view .${BTN_CLASS} {
  position: absolute;
  top: 0;
  right: 0;
  width: ${SIZE}px;
  height: ${SIZE}px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
#rnp-view .${BTN_CLASS} svg { width: 18px; height: 18px; display: block; }
#rnp-view .am-music-volume-controls .rnp-amll-volume-slider {
  position: absolute;
  top: 0;
  left: 12px;
  right: ${SIZE + 4}px;
  width: auto;
  height: ${SIZE}px;
  min-height: 0;
  opacity: 0;
  transition: opacity 0.16s ease;
}
#rnp-view .am-music-volume-controls:hover .rnp-amll-volume-slider {
  opacity: 1;
  transition-delay: 0.08s;
}
#rnp-view .am-music-volume-controls .rnp-amll-volume-slider .appkit-now-playing-slider-icon {
  display: none;
}
`;

function install() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);
}

// Adds the speaker icon (a copy of the slider's own) and lines the control up with the more
// button, whose position depends on the window size and the song info's height.
function attach() {
  const mn = document.querySelector(MN);
  const vol = mn && mn.querySelector('.am-music-volume-controls');
  const more = mn && mn.querySelector('.rnp-info-more-button');
  if (!vol || !more) return;
  if (!vol.querySelector('.' + BTN_CLASS)) {
    const icon = vol.querySelector('.appkit-now-playing-slider-icon:last-child');
    const btn = document.createElement('span');
    btn.className = BTN_CLASS;
    btn.setAttribute('aria-hidden', 'true');
    if (icon) btn.innerHTML = icon.innerHTML;
    vol.appendChild(btn);
  }
  const m = mn.getBoundingClientRect();
  const b = more.getBoundingClientRect();
  if (!m.width || !b.width) return;
  vol.style.setProperty('--bncm-vol-top', Math.round(b.top - m.top) + 'px');
  vol.style.setProperty('--bncm-vol-right', Math.round(m.right - b.left + GAP) + 'px');
}

function start() {
  install();
  attach();
  // RNPN builds its view after plugins load and re-renders it per track; re-check cheaply.
  setInterval(attach, 2000);
  window.addEventListener('resize', attach);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
