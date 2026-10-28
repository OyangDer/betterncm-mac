// RefinedNowPlayingNext's fullscreen buttons use the HTML Fullscreen API, which NCM's macOS shell
// does not wire to the window: a click only flips the button's tooltip and leaves the document in
// a fullscreen state the window never shows. NCM's native winhelper.setWindowFullScreen is not
// implemented on macOS either, so hide the buttons; the green traffic-light button and Ctrl-Cmd-F
// already do this.

const STYLE_ID = 'bncm-compat-rnp-fullscreen';
const CSS = `
.rnp-window-tool-fullscreen,
.rnp-full-screen-button { display: none !important; }
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
