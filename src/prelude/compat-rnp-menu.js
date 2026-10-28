// Compat for RefinedNowPlayingNext's "···" (more) button on the song info.
//
// The button has no menu of its own: it clicks NCM's own "more" button on the (covered) vinyl
// page, picking the right-most candidate. On Windows NCM 3.x that button sits beside the song
// info; on macOS 3.1.14 it is in the top-right toolbar, so NCM's dropdown opens in the top-right
// corner, partly off-screen. When the dropdown opens right after a click on the RNPN button,
// move it so it opens upward from that button instead.

const RNP_MORE = '.rnp-info-more-button';
const MENU = '.cmd-portal-inner';
const WAIT_MS = 1500;
const GAP = 8;

function placeMenu(menu, anchor) {
  const a = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const left = Math.max(GAP, Math.min(a.left, innerWidth - m.width - GAP));
  const fitsAbove = a.top - GAP - m.height >= GAP;
  const top = fitsAbove ? a.top - GAP : Math.min(a.bottom + GAP, innerHeight - m.height - GAP);
  const style = menu.style;
  if (style.left !== left + 'px') style.left = left + 'px';
  if (style.top !== top + 'px') style.top = top + 'px';
  const transform = fitsAbove ? 'translateY(-100%)' : 'none';
  if (style.transform !== transform) style.transform = transform;
  const inner = menu.firstElementChild;
  if (inner) inner.style.transformOrigin = fitsAbove ? '11px 100%' : '11px 0%';
}

// NCM rewrites the inline position while the dropdown is open, so keep re-applying ours until it
// closes.
function pin(menu, anchor) {
  if (menu.__bncmPinned) return;
  menu.__bncmPinned = true;
  placeMenu(menu, anchor);
  const mo = new MutationObserver(() => {
    if (!menu.isConnected || menu.getBoundingClientRect().width === 0) {
      mo.disconnect();
      menu.__bncmPinned = false;
      return;
    }
    placeMenu(menu, anchor);
  });
  mo.observe(menu, { attributes: true, attributeFilter: ['style'] });
  const done = () => { mo.disconnect(); menu.__bncmPinned = false; };
  // Removal of the portal is not an attribute change; check for it cheaply.
  const watch = setInterval(() => {
    if (!menu.isConnected || menu.getBoundingClientRect().width === 0) { clearInterval(watch); done(); }
  }, 300);
}

document.addEventListener('click', (e) => {
  const anchor = e.target instanceof Element && e.target.closest(RNP_MORE);
  if (!anchor) return;
  const deadline = performance.now() + WAIT_MS;
  const look = () => {
    const menu = [...document.querySelectorAll(MENU)].find((m) => m.getBoundingClientRect().width > 0);
    if (menu) {
      pin(menu, anchor);
      return;
    }
    // Timers, not requestAnimationFrame: rAF stalls while the window is occluded.
    if (performance.now() < deadline) setTimeout(look, 30);
  };
  setTimeout(look, 0);
}, true);
