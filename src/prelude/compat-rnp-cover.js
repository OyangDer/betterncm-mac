// Apple Music-style cover motion for RefinedNowPlayingNext: the cover (and the shadow RNPN draws
// on its wrapper) shrinks while paused and springs back to full size when playback resumes.
// Only `transform` animates, so it costs the compositor almost nothing.
//
// The play state comes from audioplayer.onPlayState through the channel shim, which also replays
// the current state to listeners that register after a page load. Without the shim there is no
// reliable state, so the cover simply stays full size.

const STYLE_ID = 'bncm-compat-rnp-cover';
const PAUSED = 'bncm-cover-paused';
const COVER = '#rnp-view .n-single .cdin';
const CSS = `
${COVER} {
  transform-origin: 50% 50%;
  transition: transform 0.55s cubic-bezier(0.3, 1.3, 0.5, 1);
}
body.${PAUSED} ${COVER} {
  transform: scale(0.84);
  transition: transform 0.45s cubic-bezier(0.4, 0, 0.2, 1);
}
`;

function install() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);
}

function start() {
  const ch = window.channel;
  if (!ch || typeof ch.registerCall !== 'function') return;
  install();
  ch.registerCall('audioplayer.onPlayState', (_id, state) => {
    const s = String(state || '').split('|').pop();
    if (s === 'pause' || s === 'stop') document.body.classList.add(PAUSED);
    else if (s === 'resume' || s === 'play') document.body.classList.remove(PAUSED);
  });
}

// The channel shim installs window.channel in a capture listener on window, which runs before
// this one on document.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
