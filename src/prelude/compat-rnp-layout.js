// Layout tweaks for RefinedNowPlayingNext's built-in player controls.
//
// The full-width volume slider row under the transport buttons becomes a small speaker button
// beside the song info's "···" (more) button, drawn in the same style: both are bare icons that
// get a light tint under the pointer. Hovering it widens it to
// the left into a pill holding the slider, with the speaker staying put at the right end. Taking
// the row out of the flow also lets the bottom-aligned cover and controls block sit lower.
//
// The lyric column is capped at LYRIC_COLUMN_VW of the window width (RNPN lets it fill the whole
// right side, ~51% at 1920px), close to Apple Music's ~36%, so lines wrap earlier and the page
// reads tighter. RNPN re-lays out the lyrics from a ResizeObserver on that container.
//
// The cover follows Apple Music's proportion, ~28% of the window width, capped at half the window
// height so the cover plus controls still fit in a wide fullscreen window (RNPN uses 24vw).
//
// The cover and controls block, centered in the full window height, reads high: the top ~30px
// hold the window's traffic lights, so it is nudged down by BLOCK_SHIFT_VH to center it in the
// area below them.
//
// The volume control stays where RNPN rendered it in the DOM (moving nodes RNPN owns would
// fight its rendering); it is positioned against .mn, the column holding both the song info and
// the controls, at the offsets measured from the more button. An RNPN build without that button
// keeps its own volume row.

const STYLE_ID = 'bncm-compat-rnp-layout';
const BTN_CLASS = 'bncm-vol-btn';
const STOCK_VOLUME = 'bncm-vol-stock'; // on <body> when there is no more button to sit beside
const SIZE = 30; // matches .rnp-info-more-button
const GAP = 8;
const OPEN_WIDTH = 170;
const MN = '#rnp-view .g-single-track .g-singlec-ct .n-single .mn';
const LYRIC_COLUMN_VW = 38;
const BLOCK_SHIFT_VH = 3;
const VOL = `body:not(.${STOCK_VOLUME}) #rnp-view .am-music-volume-controls`;

const CSS = `
#rnp-view { --rnp-v3-cover-width: clamp(240px, min(28vw, 50vh), 640px) !important; }
#rnp-view .g-single-track .g-singlec-ct .n-single .rnp-v3-side { transform: translateY(${BLOCK_SHIFT_VH}vh); }
/* + 60px: .rnp-lyrics's own horizontal padding */
#rnp-view .rnp-lyrics { max-width: calc(${LYRIC_COLUMN_VW}vw + 60px); }
/* The title clips its overflow (for its marquee) at a 1.08 line height, cutting off descenders
   such as g; room below the text, taken back by the margin so nothing moves. */
#rnp-view .n-single .mn .title .name { padding-bottom: 0.18em; margin-bottom: -0.18em; }
/* Translations (and romaji) under the original line: RNPN draws translations at the original's
   size, which CJK text makes look heavier than the line it translates, the more so the larger the
   lyrics. 0.62em + 6px shrinks it more as the lyrics grow, as Apple Music sets translations
   smaller: ~0.9x at 20px, ~0.8x at 30px, ~0.75x at 50px. A smaller size picked in RNPN's
   settings (--lyric-translation-size-em) still wins. */
#rnp-view .rnp-lyrics-line > div.rnp-lyrics-line-translated {
  font-size: min(var(--lyric-translation-size-em, 1em), calc(0.62em + 6px));
  margin-top: 0.12em;
}
${MN} { position: relative; }
${VOL} {
  position: absolute;
  top: var(--bncm-vol-top, 0px);
  right: var(--bncm-vol-right, ${SIZE + GAP}px);
  width: ${SIZE}px !important; /* RNPN sizes the volume row with a more specific rule */
  height: ${SIZE}px;
  border-radius: ${SIZE / 2}px; /* a circle, and a capsule when open, like the other controls */
  overflow: hidden;
  background: transparent;
  color: rgba(var(--rnp-accent-color-shade-2-rgb), 0.72);
  transition: width 0.24s cubic-bezier(0.2, 0.8, 0.2, 1), background-color 0.2s ease, color 0.2s ease;
}
/* Plain icons like the rest of the page; a tint only under the pointer. */
#rnp-view .rnp-info-more-button {
  background: transparent !important;
  border-radius: 50% !important;
  transition: background-color 0.2s ease;
}
#rnp-view .rnp-info-more-button:hover { background: rgba(var(--rnp-accent-color-shade-2-rgb), 0.1) !important; }
${VOL}:hover {
  width: ${OPEN_WIDTH}px !important;
  background: rgba(var(--rnp-accent-color-shade-2-rgb), 0.14);
  color: rgba(var(--rnp-accent-color-shade-2-rgb), 0.96);
}
body:not(.${STOCK_VOLUME}) #rnp-view .${BTN_CLASS} {
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
body:not(.${STOCK_VOLUME}) #rnp-view .${BTN_CLASS} svg { width: 18px; height: 18px; display: block; }
${VOL} .rnp-amll-volume-slider {
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
${VOL}:hover .rnp-amll-volume-slider {
  opacity: 1;
  transition-delay: 0.08s;
}
${VOL} .rnp-amll-volume-slider .appkit-now-playing-slider-icon {
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
  // Only a rendered volume row without the button says this build lays out differently; either
  // missing alone just means the lyric page has not been built yet.
  if (vol) document.body.classList.toggle(STOCK_VOLUME, !more);
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
  // Unrounded, so it lines up with the more button to the pixel.
  vol.style.setProperty('--bncm-vol-top', (b.top - m.top) + 'px');
  vol.style.setProperty('--bncm-vol-right', (m.right - b.left + GAP) + 'px');
}

function start() {
  install();
  // RNPN measures the cover column on resize to center it; have it re-measure with our width.
  window.dispatchEvent(new Event('resize'));
  attach();
  // RNPN builds its view after plugins load and re-renders it per track; re-check cheaply.
  setInterval(attach, 2000);
  window.addEventListener('resize', attach);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
