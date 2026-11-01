// Performance compat for RefinedNowPlayingNext's "text glow" setting.
//
// RNPN draws the glow with `filter: drop-shadow(...)` on every lyric line. A filter gives each
// line its own render surface that is re-rasterized every frame while the lyrics scroll and
// animate, which costs ~10 fps on the lyric page here (50 -> 59 fps with the glow off, p95 frame
// 33 ms -> 17 ms). text-shadow draws the same glow with the glyphs, so the animated lines become
// cheap again. drop-shadow's blur is a standard deviation; text-shadow's is a radius (2 sigma),
// hence 10px for RNPN's 5px. The static title and song info keep the original filter.
//
// It also stops work nobody can see:
// - the progress thumb's `width` transition, which re-lays out the page every frame as progress
//   ticks in (~60 layouts/s -> ~40); a step every 100 ms is well under a pixel;
// - while the lyric page is open, the page's full-window backdrop blur, which is invisible
//   behind its opaque background but still samples everything underneath it;
// - rendering whatever the window cannot show (content-visibility: hidden keeps its state,
//   scroll positions included, and skips its style, layout and paint): RNPN's page while it is
//   closed, where its lyric updates and animations carried on offscreen, and while it is open,
//   NCM's sidebar, play bar and main pages under it, where the home page's carousel, the play
//   bar's spinning cover and progress kept re-rendering. NCM's own now-playing page sits beside
//   the main pages, not in them, so the 百科 / 相似推荐 / 评论 panels are unaffected.

const STYLE_ID = 'bncm-compat-rnp-perf';
const CSS = `
body.rnp-text-glow .rnp-lyrics-line > div,
body.rnp-text-glow .rnp-lyrics-overview-line > div,
body.rnp-text-glow .rnp-contributors > div {
  filter: none !important;
  text-shadow: 0 4px 10px rgba(var(--rnp-accent-color-shade-2-rgb), 0.27);
}
#rnp-view .appkit-now-playing-slider .thumb { transition: none !important; }
body.rnp-lyric-page-open #rnp-view { backdrop-filter: none !important; }
body:not(.rnp-lyric-page-open) #rnp-view,
body.rnp-lyric-page-open #root .should-hide-under-vinyl-mode,
body.rnp-lyric-page-open #root .ad-tutorial-step-0-stop > [class*="scrollCss_"] {
  content-visibility: hidden;
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
