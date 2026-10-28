// Lyric size that follows the window for RefinedNowPlayingNext (config mac.rnpAutoLyricSize).
//
// RNPN's font size setting is read as the size for a window filling the screen. A smaller window
// gets it scaled by the smaller of its width and height ratios to the screen (the lyric column
// is a share of the width, and fewer lines fit a lower window), so a line holds about as many
// characters at any size. MIN_SCALE and MIN_PX keep a small window readable.
//
// RNPN takes its size from the 'rnp-lyric-font-size' event, which its own slider also sends
// (with the raw value while dragging; it saves the setting on release), and lays the lyrics out
// again when the size changes. Events from the slider set the base, and the scaled size follows
// right after. The lyric view starts at the raw setting when it mounts, so a cheap check
// re-sends the scaled size whenever the rendered size differs.

const EVENT = 'rnp-lyric-font-size';
const SETTING = 'refined-now-playing-lyric-font-size';
const DEFAULT_PX = 32; // RNPN's default
const MIN_SCALE = 0.5;
const MIN_PX = 16; // RNPN slider minimum
const RESIZE_DEBOUNCE_MS = 120;
const CHECK_MS = 1000;

let base = null;
let sending = false;

function baseSize() {
  if (base != null) return base;
  const v = Number(localStorage.getItem(SETTING));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_PX;
}

function scaledSize() {
  const sw = screen.width || innerWidth;
  const sh = screen.height || innerHeight;
  const scale = Math.max(MIN_SCALE, Math.min(1, innerWidth / sw, innerHeight / sh));
  return Math.max(MIN_PX, Math.round(baseSize() * scale));
}

function send() {
  sending = true;
  try {
    document.dispatchEvent(new CustomEvent(EVENT, { detail: scaledSize() }));
  } finally {
    sending = false;
  }
}

// Only while the lyric view is mounted: RNPN ignores the event otherwise and reads its setting
// when it mounts.
function sync() {
  const lyrics = document.querySelector('#rnp-view .rnp-lyrics');
  if (!lyrics) return;
  if (parseFloat(lyrics.style.fontSize) !== scaledSize()) send();
}

function start() {
  document.addEventListener(EVENT, (e) => {
    if (sending) return;
    const v = Number(e.detail);
    if (!Number.isFinite(v) || v <= 0) return;
    base = v; // from RNPN's slider
    setTimeout(send, 0); // after RNPN has applied the raw value
  });
  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(sync, RESIZE_DEBOUNCE_MS);
  });
  setInterval(sync, CHECK_MS);
}

start();
