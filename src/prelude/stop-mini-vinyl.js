// Stops NCM's own mini vinyl in the play bar (config mac.stopMiniVinyl). Its endless rotation
// alone keeps the page producing frames (~60 style recalcs/s -> ~13 with nothing else playing)
// and the window being recomposited, even with the lyric page closed. The cover stays, it just
// no longer spins.

const STYLE_ID = 'bncm-stop-mini-vinyl';
const CSS = `
[class*="miniVinylWrapper"] { animation-play-state: paused !important; }
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
