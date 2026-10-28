// Layout tweaks for RefinedNowPlayingNext's built-in player controls.
//
// The full-width volume slider row under the transport buttons becomes a small speaker button
// at the right end of the transport row; hovering it pops the slider up above. Taking the row
// out of the flow also lets the bottom-aligned cover and controls block sit lower.

const STYLE_ID = 'bncm-compat-rnp-layout';
const BTN_CLASS = 'bncm-vol-btn';
const CSS = `
#rnp-view .rnp-v3-controls { position: relative; }
#rnp-view .am-music-volume-controls {
  position: absolute;
  right: 0;
  top: var(--bncm-vol-top, 82px);
  width: 28px;
  height: 28px;
}
#rnp-view .${BTN_CLASS} {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.62;
  cursor: pointer;
  transition: opacity 0.15s ease;
}
#rnp-view .am-music-volume-controls:hover .${BTN_CLASS} { opacity: 1; }
#rnp-view .${BTN_CLASS} svg { width: 22px; height: 22px; display: block; }
/* lets the pointer travel from the button up to the panel without losing :hover */
#rnp-view .am-music-volume-controls::before {
  content: "";
  position: absolute;
  right: 0;
  bottom: 100%;
  width: 28px;
  height: 14px;
}
#rnp-view .am-music-volume-controls .rnp-amll-volume-slider {
  position: absolute;
  right: -10px;
  bottom: calc(100% + 8px);
  width: 200px;
  min-height: 0;
  padding: 10px 12px;
  box-sizing: border-box;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.6);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
  opacity: 0;
  pointer-events: none;
  transform: translateY(6px) scale(0.96);
  transform-origin: calc(100% - 24px) 100%;
  transition: opacity 0.18s ease, transform 0.18s ease;
}
body:not(.rnp-system-light) #rnp-view .am-music-volume-controls .rnp-amll-volume-slider {
  background: rgba(30, 30, 30, 0.6);
}
#rnp-view .am-music-volume-controls:hover .rnp-amll-volume-slider {
  opacity: 1;
  pointer-events: auto;
  transform: none;
}
`;

function install() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);
}

// Adds the speaker button (a copy of the slider's own speaker icon) and aligns the control with
// the transport row, whose offset depends on the progress block above it.
function attach() {
  const vol = document.querySelector('#rnp-view .am-music-volume-controls');
  const transport = document.querySelector('#rnp-view .am-music-controls');
  if (!vol || !transport) return;
  if (!vol.querySelector('.' + BTN_CLASS)) {
    const icon = vol.querySelector('.appkit-now-playing-slider-icon:last-child');
    const btn = document.createElement('span');
    btn.className = BTN_CLASS;
    btn.setAttribute('aria-hidden', 'true');
    if (icon) btn.innerHTML = icon.innerHTML;
    vol.appendChild(btn);
  }
  if (transport.offsetHeight > 0) {
    const top = transport.offsetTop + (transport.offsetHeight - 28) / 2;
    vol.style.setProperty('--bncm-vol-top', top + 'px');
  }
}

function start() {
  install();
  attach();
  // RNPN builds its view after plugins load and re-renders it per track; re-check cheaply.
  new MutationObserver(() => {
    if (!document.querySelector('#rnp-view .' + BTN_CLASS)) attach();
  }).observe(document.body, { childList: true, subtree: false });
  setInterval(attach, 2000);
  window.addEventListener('resize', attach);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
