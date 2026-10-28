// Performance compat for RefinedNowPlayingNext's "text glow" setting.
//
// RNPN draws the glow with `filter: drop-shadow(...)` on every lyric line. A filter gives each
// line its own render surface that is re-rasterized every frame while the lyrics scroll and
// animate, which costs ~10 fps on the lyric page here (50 -> 59 fps with the glow off, p95 frame
// 33 ms -> 17 ms). text-shadow draws the same glow with the glyphs, so the animated lines become
// cheap again. drop-shadow's blur is a standard deviation; text-shadow's is a radius (2 sigma),
// hence 10px for RNPN's 5px. The static title and song info keep the original filter.

const STYLE_ID = 'bncm-compat-rnp-perf';
const CSS = `
body.rnp-text-glow .rnp-lyrics-line > div,
body.rnp-text-glow .rnp-lyrics-overview-line > div,
body.rnp-text-glow .rnp-contributors > div {
  filter: none !important;
  text-shadow: 0 4px 10px rgba(var(--rnp-accent-color-shade-2-rgb), 0.27);
}
`;

function install() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
else install();
