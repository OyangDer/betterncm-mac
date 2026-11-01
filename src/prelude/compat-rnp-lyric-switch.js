// RefinedNowPlayingNext's lyric switches (译 translation, 音 romaji, 逐字 word-by-word, in a
// column at the lyrics' right edge that shows under the pointer), drawn like the page's other
// controls (config mac.rnpAppleStyle): bare text in the cover's colour instead of filled 4px-
// rounded squares, round (a capsule for 逐字), with a tint under the pointer and a filled one
// when on. RNPN sets the text vertically in a 20px column; it runs horizontally here, in a column
// as wide as the top-right tools (28px), which a capsule may overhang.

const STYLE_ID = 'bncm-compat-rnp-lyric-switch';
const FG = 'var(--rnp-accent-color-shade-2-rgb)';
const COL = '#rnp-view .rnp-lyrics-switch';
const BTN = `${COL} .rnp-lyrics-switch-btn`;
const SIZE = 28;

const CSS = `
${COL} {
  width: ${SIZE}px;
  right: -${SIZE + 8}px;
  align-items: center;
}
${BTN} {
  box-sizing: border-box;
  writing-mode: horizontal-tb;
  width: auto;
  min-width: ${SIZE}px;
  height: ${SIZE}px;
  margin-top: 4px;
  padding: 0 8px;
  border-radius: ${SIZE / 2}px;
  white-space: nowrap;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  line-height: 1;
  background-color: transparent;
  color: rgba(${FG}, 0.62);
}
${BTN} svg { fill: currentColor; }
${BTN}:hover { background-color: rgba(${FG}, 0.1); color: rgba(${FG}, 0.96); }
${BTN}.active { background-color: rgba(${FG}, 0.18); color: rgb(${FG}); }
${BTN}.active svg { fill: currentColor; }
${BTN}.unavailable { opacity: 0.25; }
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
