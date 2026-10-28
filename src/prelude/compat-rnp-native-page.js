// Opens RefinedNowPlayingNext's page whenever NCM opens its own now-playing (vinyl) page.
//
// RNPN replaces the vinyl page by intercepting clicks on the play bar's cover. NCM also opens
// that page without such a click, most visibly when roaming (漫游) starts, and then the stock
// page shows instead of RNPN's (on top of it, if RNPN's was already open). NCM shows and hides
// the page by setting `display` in the inline style of #vinyl-page-container, so a
// MutationObserver on that one attribute sees it open before it is painted. The page is hidden
// at once, RNPN's page is opened the way RNPN expects (a click on .miniVinylWrapper, which its
// capture listener takes and keeps from NCM), and the stock page is closed with its own collapse
// button so it does not keep rendering underneath. Newer RNPN builds (not 3.0.2) let a
// shift-click on the cover through to NCM on purpose; that one is left alone.

const CONTAINER = '#vinyl-page-container';
const COLLAPSE = '[data-testid="tid_vinyl_unfold_btn"], .close button';
const PAGE_OPEN = 'rnp-lyric-page-open';
const BIND_CHECK_MS = 2000; // re-find the container, re-check its state
const COLLAPSE_RETRY_MS = 250; // NCM ignores the collapse button while the page is still opening
const COLLAPSE_TRIES = 10;

let bound = null;
let observer = null;
let replacing = false;
let stuck = false; // the stock page would not close; leave it until NCM hides it itself
let shiftOpen = false;

const rnpLoaded = () => !!window.loadedPlugins?.RefinedNowPlayingNext;
const isShown = (el) => getComputedStyle(el).display !== 'none';
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

function openRnp() {
  // RNPN keys on the target's closest .miniVinylWrapper; the play bar's cover is one, but it is
  // not rendered in every mode, so a temporary stand-in is used when it is missing.
  let target = document.querySelector('footer .miniVinylWrapper');
  let temp = null;
  if (!target) {
    temp = document.createElement('div');
    temp.className = 'miniVinylWrapper';
    temp.style.cssText = 'position:fixed;width:0;height:0;pointer-events:none';
    document.body.appendChild(temp);
    target = temp;
  }
  try {
    click(target);
  } finally {
    temp?.remove();
  }
}

function onStyleChange() {
  const el = bound;
  if (!el || replacing) return;
  if (!isShown(el)) {
    stuck = false;
    return;
  }
  if (stuck || shiftOpen || !rnpLoaded()) return;
  replacing = true;
  el.style.setProperty('visibility', 'hidden', 'important');
  try {
    if (!document.body.classList.contains(PAGE_OPEN)) openRnp();
  } catch (e) {
    console.warn('[BetterNCM] could not open RNPN for the stock now-playing page', e);
  }
  // Collapse until NCM has hidden it, then unhide it for its next opening. A page that will
  // not close is shown again rather than left invisible over everything.
  let tries = 0;
  const collapse = () => {
    if (isShown(el) && tries++ < COLLAPSE_TRIES) {
      const button = el.querySelector(COLLAPSE);
      if (button) click(button);
      setTimeout(collapse, COLLAPSE_RETRY_MS);
      return;
    }
    stuck = isShown(el);
    if (stuck) console.warn('[BetterNCM] the stock now-playing page did not close');
    el.style.removeProperty('visibility');
    replacing = false;
  };
  setTimeout(collapse, 0);
}

function bind() {
  const el = document.querySelector(CONTAINER);
  if (el === bound) return;
  observer?.disconnect();
  bound = el;
  if (!el) return;
  observer = new MutationObserver(onStyleChange);
  observer.observe(el, { attributes: true, attributeFilter: ['style'] });
}

// NCM may open its page before the click event, so the shift is noted from the press on.
const noteShift = (e) => {
  if (e.shiftKey && e.target?.closest?.('.miniVinylWrapper')) {
    shiftOpen = true;
    setTimeout(() => { shiftOpen = false; }, 1000);
  }
};
for (const type of ['pointerdown', 'mousedown', 'click']) document.addEventListener(type, noteShift, true);

// The timer also covers a page that was already open when RNPN finished loading (NCM reopens
// it after a reload while roaming), which no style change would report.
bind();
setInterval(() => {
  bind();
  onStyleChange();
}, BIND_CHECK_MS);
