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
// shift-click on the cover through to NCM on purpose; that one is left alone until it closes.
// So is the page compat-rnp-panels.js opens over RNPN's to show NCM's 百科, 相似推荐 or comments
// (<body> has PANEL_CLASS meanwhile).
//
// The clicks carry a real point, the target's center. RNPN's capture listener swallows any click
// whose point lies in the play bar (<footer>) as a click on the bar, and while RNPN's page is
// open its CSS moves the bar above the window (`bottom: 100%`), so a synthetic click's default
// point, (0, 0), lies on the bar's lower edge: RNPN would swallow every collapse click until NCM
// shrinks the bar to no height, 1.5s or more into its page.

const CONTAINER = '#vinyl-page-container';
const COLLAPSE = '[data-testid="tid_vinyl_unfold_btn"], .close button';
const PAGE_OPEN = 'rnp-lyric-page-open';
const PANEL_CLASS = 'bncm-rnp-panel';
const SHIFT_WAIT_MS = 1000; // how long a shift-click has to open the page
const BIND_CHECK_MS = 2000; // re-find the container, re-check its state
const COLLAPSE_RETRY_MS = 250; // while the collapse button is not rendered
// After a click: NCM ignores the button while its page is still sliding in (~450ms), and its
// closing animation takes about as long.
const COLLAPSE_WAIT_MS = 700;
const COLLAPSE_TRIES = 10;

let bound = null;
let observer = null;
let replacing = false;
let stuck = false; // the stock page would not close; leave it until NCM hides it itself
let shiftOpen = false;
let wasShown = false;

const rnpLoaded = () => !!window.loadedPlugins?.RefinedNowPlayingNext;
const isShown = (el) => getComputedStyle(el).display !== 'none';

function click(el) {
  const r = el.getBoundingClientRect();
  const point = r.width || r.height
    ? { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
    : { clientX: innerWidth / 2, clientY: innerHeight / 2 }; // not laid out: anywhere off the bar
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, ...point }));
}

// The next frame, or at once where there are no frames to wait for (tests).
const onFrame = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : fn());

// Opacity as well as visibility: the record's cover image sets `visibility: visible` on itself,
// which overrides a hidden parent, and showed as a record flying in.
function hide(el) {
  el.style.setProperty('visibility', 'hidden', 'important');
  el.style.setProperty('opacity', '0', 'important');
}

function unhide(el) {
  el.style.removeProperty('visibility');
  el.style.removeProperty('opacity');
}

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
    if (wasShown) shiftOpen = false; // the shift-opened page has closed
    wasShown = false;
    return;
  }
  wasShown = true;
  // NCM hides the page only at the end of its closing animation, and a hidden window plays no
  // animations; this runs again when the window shows.
  if (stuck || shiftOpen || document.body.classList.contains(PANEL_CLASS) || document.hidden || !rnpLoaded()) return;
  replacing = true;
  hide(el);
  try {
    if (!document.body.classList.contains(PAGE_OPEN)) openRnp();
  } catch (e) {
    console.warn('[BetterNCM] could not open RNPN for the stock now-playing page', e);
  }
  // Collapse until NCM has hidden it, then unhide it for its next opening. Each check waits for
  // a frame, so the time a covered window spends undrawn (playing no closing animation) does not
  // count against the page. A page that will not close is shown again rather than left
  // invisible over everything.
  let tries = 0;
  const collapse = () => {
    if (document.body.classList.contains(PANEL_CLASS)) {
      // compat-rnp-panels.js took the page over meanwhile; it is its page now
      unhide(el);
      replacing = false;
      return;
    }
    if (isShown(el) && tries++ < COLLAPSE_TRIES) {
      const button = el.querySelector(COLLAPSE);
      if (button) click(button);
      setTimeout(() => onFrame(collapse), button ? COLLAPSE_WAIT_MS : COLLAPSE_RETRY_MS);
      return;
    }
    stuck = isShown(el);
    if (stuck) console.warn('[BetterNCM] the stock now-playing page did not close');
    unhide(el);
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

// NCM may open its page before the click event, so the shift is noted from the press on. It
// holds until the page closes again (onStyleChange), or lapses if the page never opened.
const noteShift = (e) => {
  if (e.shiftKey && e.target?.closest?.('.miniVinylWrapper')) {
    shiftOpen = true;
    setTimeout(() => { if (!bound || !isShown(bound)) shiftOpen = false; }, SHIFT_WAIT_MS);
  }
};
for (const type of ['pointerdown', 'mousedown', 'click']) document.addEventListener(type, noteShift, true);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  stuck = false;
  onStyleChange();
});

// The timer also covers a page that was already open when RNPN finished loading (NCM reopens
// it after a reload while roaming), which no style change would report.
bind();
setInterval(() => {
  bind();
  onStyleChange();
}, BIND_CHECK_MS);
