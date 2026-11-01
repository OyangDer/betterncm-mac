// 百科, 相似推荐 and comments on RefinedNowPlayingNext's page (config mac.rnpAppleStyle).
//
// RNPN's page has lyrics only. NCM's own now-playing (vinyl) page has the rest: a 歌词 / 百科 /
// 相似推荐 tab group in its right column, and a comment section one screen below it (its
// classicModeTab 'comment', reached there by scrolling down). Rather than rebuild those, a
// switcher in RNPN's top-right tool row opens NCM's page over RNPN's in "panel mode": everything of NCM's
// page is hidden except the chosen tab's content or the comment section, which is laid over
// RNPN's lyric column with RNPN's palette, so playing a similar song, liking or replying to a
// comment all stay NCM's own working controls. Scrolling down on the cover side of the page also
// opens the comments, as the original RefinedNowPlaying did; a new upward swipe at the top of the
// comments goes back to the lyrics (onPanelWheel).
//
// NCM's page sits above RNPN's (z-index 1000 over 998) and covers the window; in panel mode it
// takes no pointer events except on the shown content, so RNPN's cover and controls stay usable.
// compat-rnp-native-page.js leaves NCM's page alone while <body> has PANEL_CLASS, which therefore
// stays until the page has finished closing (display: none), not just until NCM starts to close
// it: in between NCM slides the page down, and without the class that would show as the stock
// page, or be taken for one opening and swapped for RNPN's.
//
// Body classes and attributes, in the order they come and go:
//   PANEL_CLASS   NCM's page is ours: open, opening or closing
//   VIEW_ATTR     the view the switcher shows as chosen ('lyrics' hides the panel at once)
//   READY_CLASS   NCM shows the chosen tab; until then the panel stays invisible, so the page's
//                 own lyrics (its default tab) never show while it opens on another tab
//   CLOSING_CLASS NCM's page is closing; hidden for its close animation
//
// The tab is NCM's state: page:vinylPage's displayType ('lyric' | 'baike' | 'similar', what its
// tab clicks set, persisted) and classicModeTab ('default' | 'comment'). Panels set both with
// page:vinylPage/onUpdate, which is not persisted, before opening the page, so it opens on the
// right tab; when the page has closed, both go back to what they were, so NCM's own page still
// opens on its lyrics.
//
// NCM closes its page itself when one of its links is followed (a playlist or album under
// 相似推荐, a user in the comments), to show the destination, which RNPN's page would still
// cover; RNPN's page is closed then too, as RNPN does for its own 歌手 / 专辑 links.

const STYLE_ID = 'bncm-compat-rnp-panels';
const PANEL_CLASS = 'bncm-rnp-panel';
const READY_CLASS = 'bncm-rnp-panel-ready';
const CLOSING_CLASS = 'bncm-rnp-panel-closing';
const VIEW_ATTR = 'data-bncm-rnp-view';
const SWITCHER_ID = 'bncm-rnp-views';
const RNP_OPEN = 'rnp-lyric-page-open';
const CONTAINER = '#vinyl-page-container';
const COLLAPSE = '[data-testid="tid_vinyl_unfold_btn"]';
const TABS = `${CONTAINER} ul.tab-group`;
const PLAYBAR_COMMENTS = '[data-testid="tid_playbar_comment_btn"]';
const AREA = `${CONTAINER} .display .area`;
const COMMENTS = `${CONTAINER} [class*="CommentAreaContainer_"]`;
const LYRICS = '#rnp-view .rnp-lyrics';
const RNP_CLOSE = '#rnp-view .rnp-window-tool-plugin-close';
const LYRIC_PARTS = '#rnp-view .lyric > :is(.rnp-lyrics, .rnp-lyrics-switch, .rnp-lyrics-scrollbar)';
const TOOLS = '#rnp-view .rnp-window-tools';
const OPEN_CLASS = 'bncm-open';
const BTN = 28; // RNPN's top-right tools, and the ones compat-rnp-top-controls.js adds
const GAP = 4;
const RIM = 3; // the open capsule's margin around its buttons
const TOP_CLEAR = 56; // panels start below the top-right controls
const WHEEL_TO_COMMENTS = 160; // px of downward scrolling on the cover side opens the comments
const WHEEL_RESET_MS = 400;
const OPEN_WAIT_MS = 3000;
const COMMENTS_WAIT_MS = 1500; // NCM builds without the comment section get its comment page
const CLOSE_TRIES = 8;
const CLOSE_RETRY_MS = 500;
const HIDE_FRAMES = 60; // drawn frames to wait for NCM's ~0.5s close animation before giving up
const CHECK_MS = 1000;
const HOVER_INTENT_MS = 120; // the pointer rests this long on the switcher before it opens
const GESTURE_GAP_MS = 250; // a pause this long between wheel events starts a new gesture
const WHEEL_TO_LYRICS = 240; // px of a new upward gesture at the top of the comments

// SF Symbols-like line icons, 20pt grid.
const svg = (body) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const VIEWS = [
  { id: 'lyrics', label: '歌词', icon: svg('<path d="M4.5 4h11A1.5 1.5 0 0 1 17 5.5v7a1.5 1.5 0 0 1-1.5 1.5H10l-3.6 2.8V14H4.5A1.5 1.5 0 0 1 3 12.5v-7A1.5 1.5 0 0 1 4.5 4z"/><path d="M7.6 7.4v1.4c0 .9-.4 1.5-1.1 1.8M11.6 7.4v1.4c0 .9-.4 1.5-1.1 1.8" stroke-width="1.7"/>') },
  { id: 'baike', label: '百科', tab: '百科', display: 'baike', icon: svg('<circle cx="10" cy="10" r="7"/><path d="M10 9v4.5"/><circle cx="10" cy="6.4" r=".4" fill="currentColor"/>') },
  { id: 'similar', label: '相似推荐', tab: '相似推荐', display: 'similar', icon: svg('<rect x="3" y="7.5" width="10" height="9" rx="1.8"/><path d="M6 5h8.2A1.8 1.8 0 0 1 16 6.8V14"/><path d="M8.5 15V10.3l3-.8V14"/>') },
  { id: 'comment', label: '评论', icon: svg('<path d="M3 5.3A1.3 1.3 0 0 1 4.3 4h7.4A1.3 1.3 0 0 1 13 5.3v4.4A1.3 1.3 0 0 1 11.7 11H7.5L5 13v-2h-.7A1.3 1.3 0 0 1 3 9.7z"/><path d="M15 8h.7A1.3 1.3 0 0 1 17 9.3v4.4a1.3 1.3 0 0 1-1.3 1.3H15v2l-2.5-2H9.3A1.3 1.3 0 0 1 8 13.7V13"/>') },
];

const FG = 'var(--rnp-accent-color-shade-2-dark-rgb, 255, 255, 255)';
const VFG = 'var(--rnp-accent-color-shade-2-rgb, 255, 255, 255)'; // inside #rnp-view
const P = `body.${PANEL_CLASS}`;
const C = `${P} ${CONTAINER}`;
const SHOWN = `${P}.${READY_CLASS}:not(.${CLOSING_CLASS}):not([${VIEW_ATTR}="lyrics"])`;
// NCM's page colours its text with these (rgba(255,255,255,a) for a in 1..0.03); the hashed
// prefix belongs to NCM 3.1.14's build, and without it the text just stays white.
const PALETTE = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.25, 0.1, 0.06, 0.03]
  .map((a, i) => `--v1ep2mqc-${i + 1}: rgba(${FG}, ${a}) !important;`).join(' ');
const FADE = 'linear-gradient(transparent, #000 8px, #000 calc(100% - 56px), transparent)';

const CSS = `
${C} {
  background: transparent !important;
  pointer-events: none !important;
  transform: none !important; /* no slide-up: the content fades in where the lyrics were */
  ${PALETTE}
}
/* NCM's close animation, unseen; the page is invisible until it is display: none. */
${P}.${CLOSING_CLASS} ${CONTAINER} { opacity: 0 !important; visibility: hidden !important; }
${C} #VINYL_COVER_ELEMENT_ID { background: none !important; }
${C} #VINYL_COVER_ELEMENT_ID > .mask,
${C} .page-header,
${C} .page-footer,
${C} .VinylPageLayoutContainer_vwagppq > :not(.display),
${C} .display > :not([class*="TrackDisplayContainer_"]),
${C} ul.tab-group {
  visibility: hidden !important;
  opacity: 0 !important; /* the record's cover sets visibility: visible on itself */
  pointer-events: none !important;
}
${C} [class*="CommentTabContainer_"] > :not([class*="CommentAreaContainer_"]) { display: none !important; }
${C} [class*="ClassicPageContainer_"] { transform: none !important; }
${C} .display,
${C} [class*="CommentTabContainer_"] {
  position: fixed !important;
  left: var(--bncm-panel-left) !important;
  top: var(--bncm-panel-top) !important;
  width: var(--bncm-panel-width) !important;
  height: var(--bncm-panel-height) !important;
  margin: 0 !important;
  padding: 0 !important;
  opacity: 0 !important;
  transform: translateY(12px) !important;
  pointer-events: none !important;
  transition: opacity 0.26s ease, transform 0.34s cubic-bezier(0.2, 0.8, 0.2, 1) !important;
}
${SHOWN} ${CONTAINER} .display,
${SHOWN} ${CONTAINER} [class*="CommentTabContainer_"] {
  opacity: 1 !important;
  transform: none !important;
  pointer-events: auto !important;
}
${P}[${VIEW_ATTR}="comment"] ${CONTAINER} .display,
${P}:not([${VIEW_ATTR}="comment"]) ${CONTAINER} [class*="CommentTabContainer_"] {
  display: none !important;
}
/* RNPN's settings menu opens over the lyric column, under NCM's page (z-index 998 < 1000) */
${P}:has(#rnp-settings:checked) ${CONTAINER} .display,
${P}:has(#rnp-settings:checked) ${CONTAINER} [class*="CommentTabContainer_"] {
  visibility: hidden !important;
  pointer-events: none !important;
}
${C} .display [class*="TrackDisplayContainer_"] { height: 100% !important; width: 100% !important; }
${C} .display .area {
  position: absolute !important;
  inset: 0 !important;
  height: auto !important;
  width: auto !important;
}
${C} .display .clip-mask { height: 100% !important; }
/* The comment list scrolls inside the panel; it is left unpositioned, so NCM's 发布评论 button
   (absolutely positioned inside it) sits against the panel, not the scrolled content. */
${C} [class*="CommentAreaContainer_"] {
  position: static !important;
  width: 100% !important;
  height: 100% !important;
  padding: 0 0 112px !important; /* the last comment can scroll clear of the button */
  box-sizing: border-box !important;
  overflow-y: auto !important;
}
${C} [class*="CommentAreaContainer_"] .publish {
  position: absolute !important;
  top: auto !important;
  bottom: 52px !important; /* above the list's bottom fade, which would fade it too */
  left: 50% !important;
  right: auto !important;
  transform: translateX(-50%) !important;
  z-index: 2;
}
${C} [class*="CommentAreaContainer_"] .publish button {
  /* nearly opaque: backdrop blur does not work under the list's mask */
  background: rgba(var(--rnp-accent-color-bg-dark-rgb, 40, 40, 46), 0.86) !important;
  border: 0.5px solid rgba(${FG}, 0.2) !important;
  border-radius: 999px !important;
  color: rgb(${FG}) !important;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
}
/* Content scrolls out under a short fade at both ends, like RNPN's lyrics, with no scrollbar. */
${C} .display .clip-mask,
${C} [class*="CommentAreaContainer_"] {
  -webkit-mask-image: ${FADE} !important;
  mask-image: ${FADE} !important;
}
${C} .display .clip-mask::-webkit-scrollbar,
${C} [class*="CommentAreaContainer_"]::-webkit-scrollbar { display: none; }
/* NCM's blue user names and @mentions, in the page's own colour */
${C} [class*="CommentAreaContainer_"] .nickname,
${C} [class*="CommentAreaContainer_"] .name-cursor,
${C} [class*="CommentAreaContainer_"] a,
${C} [class*="CommentAreaContainer_"] a .cmd-typography {
  color: rgba(${FG}, 0.72) !important;
}
/* NCM's cards, as quiet glass in the cover's colours */
${C} [class*="CardContainer_"] {
  background: rgba(${FG}, 0.07) !important;
  border-radius: 16px !important;
}
/* The lyric column, with RNPN's switches (译 / 音 / 逐字) and scrollbar beside it */
${LYRIC_PARTS} { transition: opacity 0.24s ease, visibility 0s linear 0s; }
${P}:not([${VIEW_ATTR}="lyrics"]) ${LYRIC_PARTS} {
  opacity: 0 !important;
  visibility: hidden !important;
  pointer-events: none !important;
  transition: opacity 0.24s ease, visibility 0s linear 0.24s;
}

/* In RNPN's top-right tool row, first: one bare icon, the current view's, shown like the row's
   other buttons only while the pointer is near the row. Under the pointer it opens leftward
   into a capsule with all four, the current one staying at its right end; a click collapses it
   again until the pointer leaves it. */
#${SWITCHER_ID} {
  position: relative;
  flex: none;
  order: -2;
  width: ${BTN}px;
  height: ${BTN}px;
  border-radius: ${BTN / 2}px;
  background: transparent;
  box-shadow: 0 0 0 ${RIM}px transparent;
  transition: width 0.3s cubic-bezier(0.2, 0.8, 0.2, 1), background-color 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease;
}
${TOOLS}:not(:hover) #${SWITCHER_ID}:not(.${OPEN_CLASS}) { opacity: 0; pointer-events: none; }
#${SWITCHER_ID}[hidden] { display: none; }
#${SWITCHER_ID}.${OPEN_CLASS} {
  width: var(--bncm-views-open-width, ${BTN}px);
  background: rgba(${VFG}, 0.1);
  box-shadow: 0 0 0 ${RIM}px rgba(${VFG}, 0.1);
}
#${SWITCHER_ID} button {
  all: unset;
  position: absolute;
  top: 0;
  right: 0;
  box-sizing: border-box;
  width: ${BTN}px;
  height: ${BTN}px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgb(${VFG});
  cursor: default;
  opacity: 0;
  pointer-events: none;
  transform: translateX(0);
  transition: transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.18s ease, background-color 0.2s ease;
}
#${SWITCHER_ID} button svg { width: 18px; height: 18px; display: block; opacity: 0.72; transition: opacity 0.2s ease; }
#${SWITCHER_ID} button[aria-pressed="true"] { opacity: 1; pointer-events: auto; z-index: 1; }
#${SWITCHER_ID}.${OPEN_CLASS} button {
  opacity: 1;
  pointer-events: auto;
  transform: translateX(calc(var(--slot) * -${BTN + GAP}px));
}
#${SWITCHER_ID}.${OPEN_CLASS} button:not([aria-pressed="true"]) svg { opacity: 0.5; }
#${SWITCHER_ID}.${OPEN_CLASS} button[aria-pressed="true"] { background: rgba(${VFG}, 0.16); }
#${SWITCHER_ID} button:hover { background: rgba(${VFG}, 0.1); }
#${SWITCHER_ID} button:hover svg { opacity: 1; }
#${SWITCHER_ID} button[hidden] { display: none; }
`;

let view = 'lyrics';
let store = null;
let switcher = null;
let wheelSum = 0;
let wheelTimer = 0;
let watching = false;
let closing = false; // NCM's page is being closed, by us or by NCM
let generation = 0; // bumped by every setView, so a superseded one stops
let saved = null; // NCM's { displayType, classicModeTab } from before the panel
let held = false; // the switcher stays collapsed after a click until the pointer leaves it
let closeTook = false; // a collapse click of closePage() has started NCM's close
let openTimer = 0;
let lastPanelWheel = 0;
let gestureAtTop = false; // the current wheel gesture began with the comment list at its top
let upSum = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const body = () => document.body;
const has = (cls) => body().classList.contains(cls);

// NCM's redux store, from the props of a component above the play bar.
function getStore() {
  if (store) return store;
  const start = document.querySelector('footer') || document.getElementById('root');
  const key = start && Object.keys(start).find((k) => k.startsWith('__reactInternalInstance$'));
  for (let f = key && start[key]; f; f = f.return) {
    const s = f.memoizedProps?.store;
    if (s?.getState && s.dispatch) return (store = s);
  }
  // From the root down, when the play bar is not rendered.
  const root = document.getElementById('root')?._reactRootContainer?._internalRoot?.current;
  const queue = root ? [root] : [];
  for (let i = 0; i < queue.length && i < 5000; i++) {
    const f = queue[i];
    const s = f.memoizedProps?.store;
    if (s?.getState && s.dispatch) return (store = s);
    if (f.child) queue.push(f.child);
    if (f.sibling) queue.push(f.sibling);
  }
  return null;
}

const vinylState = () => getStore()?.getState()['page:vinylPage'] || {};
const pageState = () => vinylState().pageState;
const pageOpen = () => pageState() === 'opened';
const pageOpening = () => pageState() === 'opening';
const update = (payload) => getStore()?.dispatch({ type: 'page:vinylPage/onUpdate', payload });
const containerHidden = () => {
  const el = document.querySelector(CONTAINER);
  return !el || getComputedStyle(el).display === 'none';
};

function click(el) {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, view: window,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
  }));
}

async function waitFor(fn, ms, stillWanted = () => true) {
  for (const end = performance.now() + ms; performance.now() < end && stillWanted(); await sleep(50)) {
    const v = fn();
    if (v) return v;
  }
  return stillWanted() && fn();
}

// Whether NCM's page shows what view `id` wants.
function showing(id) {
  if (id === 'comment') return vinylState().classicModeTab === 'comment' && !!document.querySelector(COMMENTS);
  const v = VIEWS.find((x) => x.id === id);
  return vinylState().classicModeTab !== 'comment' && !!document.querySelector(AREA)?.classList.contains(`${v.display}-mode`);
}

// What this track and NCM can show. NCM's page has the tabs and comments only in its classic
// display mode (player mode 经典, not 封面 or 歌词); its tab group is rendered even while the
// page is closed, and leaves out the tabs a track does not have (a local file has none); the
// comments need the track's comment thread.
function available(id) {
  if (id === 'lyrics') return true;
  const st = getStore()?.getState();
  if (!st || st['page:vinylEffect']?.displayMode !== 'classic') return false;
  if (id === 'comment') return !!st.playing?.resourceCommentThreadId;
  const tabs = document.querySelector(TABS);
  if (!tabs) return !document.querySelector(AREA); // tab group not built yet: assume it will be
  const label = VIEWS.find((x) => x.id === id).tab;
  return [...tabs.children].some((t) => t.textContent.trim() === label);
}

// The page's state for view `id`.
const stateFor = (id) => (id === 'comment'
  ? { classicModeTab: 'comment' }
  : { classicModeTab: 'default', displayType: VIEWS.find((x) => x.id === id).display });

// Slots count leftward from the switcher's right end: the current view's button in slot 0, the
// others to its left in their usual order.
function render() {
  body().setAttribute(VIEW_ATTR, view);
  if (!switcher) return;
  const buttons = [...switcher.querySelectorAll('button')];
  const shown = buttons.filter((b) => !b.hidden);
  const others = shown.filter((b) => b.dataset.view !== view);
  for (const b of buttons) {
    const current = b.dataset.view === view;
    b.setAttribute('aria-pressed', String(current));
    b.style.setProperty('--slot', String(current ? 0 : Math.max(0, others.length - others.indexOf(b))));
  }
  switcher.style.setProperty('--bncm-views-open-width', `${shown.length * BTN + (shown.length - 1) * GAP}px`);
}

function endPanel() {
  closing = false;
  view = 'lyrics';
  if (saved) update(saved);
  saved = null;
  body().classList.remove(PANEL_CLASS, READY_CLASS, CLOSING_CLASS);
  render();
}

// Until NCM's page is display: none. Only drawn frames count towards giving up: a covered or
// hidden window plays no animations, so NCM's close animation does not finish there.
async function waitHidden(stillWanted) {
  const frame = () => new Promise((r) => setTimeout(() => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(r) : r()), 50));
  for (let frames = 0; stillWanted(); ) {
    if (containerHidden()) return true;
    await frame();
    if (!document.hidden) frames++;
    if (frames > HIDE_FRAMES) return containerHidden();
  }
  return false;
}

// After NCM's page has started closing: keep it invisible and ours until it is display: none.
async function finishClose() {
  body().classList.add(CLOSING_CLASS);
  closing = true;
  const gen = generation;
  await waitHidden(() => gen === generation);
  if (gen === generation) endPanel();
}

// Closes NCM's page with its collapse button, repeated while NCM ignores it (as it does while the
// page is still opening).
async function closePage(gen) {
  closing = true;
  closeTook = false;
  body().classList.add(CLOSING_CLASS);
  body().classList.remove(READY_CLASS);
  for (let i = 0; i < CLOSE_TRIES && (pageOpen() || pageOpening()) && gen === generation; i++) {
    const btn = document.querySelector(`${CONTAINER} ${COLLAPSE}`);
    if (btn) click(btn);
    // NCM's click handler dispatches the close at once, if it takes the click at all
    if (!pageOpen() && !pageOpening()) closeTook = true;
    await sleep(CLOSE_RETRY_MS);
  }
  if (gen !== generation) return;
  // Not open any more: closing, or it never got there. Either way it ends hidden.
  await waitHidden(() => gen === generation);
  if (gen === generation) endPanel();
}

async function setView(next) {
  const s = getStore();
  const target = VIEWS.find((v) => v.id === next);
  if (!s || !target || !available(next)) return;
  if (next === view && (next === 'lyrics' || has(READY_CLASS))) return;
  const gen = ++generation;
  if (next === 'lyrics') {
    view = 'lyrics';
    render();
    if (has(PANEL_CLASS)) await closePage(gen);
    return;
  }
  measure();
  view = next;
  if (!has(PANEL_CLASS)) {
    const { displayType, classicModeTab } = vinylState();
    saved = { displayType: displayType || 'lyric', classicModeTab: classicModeTab || 'default' };
  }
  body().classList.add(PANEL_CLASS);
  render();
  const wanted = () => gen === generation;
  if (closing && !closeTook && (pageOpen() || pageOpening())) {
    // A close that NCM never took (it ignores collapse while opening): the page is still ours.
    closing = false;
  } else if (closing || (!pageOpen() && !pageOpening() && !containerHidden())) {
    // Still closing from an earlier panel: let it finish, then open again.
    await waitHidden(wanted);
    if (!wanted()) return;
  }
  closing = false;
  body().classList.remove(CLOSING_CLASS);
  if (!showing(next)) body().classList.remove(READY_CLASS);
  update(stateFor(next));
  if (!pageOpen() && !pageOpening()) s.dispatch({ type: 'playing/openVinylPage', payload: {} });
  if (!(await waitFor(pageOpen, OPEN_WAIT_MS, wanted))) {
    if (!wanted()) return;
    console.warn('[BetterNCM] NCM\'s now-playing page did not open for', next);
    await closePage(gen);
    return;
  }
  if (await waitFor(() => showing(next), next === 'comment' ? COMMENTS_WAIT_MS : OPEN_WAIT_MS, wanted)) {
    body().classList.add(READY_CLASS);
    return;
  }
  if (!wanted()) return;
  const btn = next === 'comment' && document.querySelector(PLAYBAR_COMMENTS);
  // The tab never came (not there for this track after all): back to RNPN's lyrics, rather than
  // NCM's own lyrics in the panel.
  view = 'lyrics';
  render();
  await closePage(gen);
  if (!btn || !wanted()) return;
  // This NCM has no comment section on its page (an A/B test): its comment page instead.
  const close = document.querySelector(RNP_CLOSE);
  if (close && has(RNP_OPEN)) click(close);
  // RNPN takes clicks on the play bar as its own while its page is open
  await waitFor(() => !has(RNP_OPEN), OPEN_WAIT_MS, wanted);
  if (wanted() && !has(RNP_OPEN)) click(btn);
}

// The panel takes RNPN's lyric column (without its horizontal padding), below the top controls.
function measure() {
  const lyrics = document.querySelector(LYRICS);
  if (!lyrics) return;
  const r = lyrics.getBoundingClientRect();
  if (!r.width) return;
  const pad = 30;
  const top = Math.max(r.top, TOP_CLEAR);
  const st = body().style;
  st.setProperty('--bncm-panel-left', `${r.left + pad}px`);
  st.setProperty('--bncm-panel-top', `${top}px`);
  st.setProperty('--bncm-panel-width', `${Math.max(240, r.width - 2 * pad)}px`);
  st.setProperty('--bncm-panel-height', `${Math.max(200, r.bottom - top)}px`);
}

// First in RNPN's tool row, put back when RNPN renders the row again. 相似推荐 is an A/B-tested
// tab; without it in NCM's tab group its button goes.
function placeSwitcher() {
  if (!switcher) return;
  let changed = false;
  for (const b of switcher.querySelectorAll('button')) {
    const hide = b.dataset.view !== view && !available(b.dataset.view);
    if (b.hidden !== hide) {
      b.hidden = hide;
      changed = true;
    }
  }
  // nothing to switch to: no switcher
  switcher.hidden = [...switcher.querySelectorAll('button')].every((b) => b.hidden || b.dataset.view === view) && view === 'lyrics';
  if (changed) render();
  const tools = document.querySelector(TOOLS);
  if (tools && switcher.parentElement !== tools) tools.prepend(switcher);
}

function buildSwitcher() {
  if (switcher) return;
  switcher = document.createElement('div');
  switcher.id = SWITCHER_ID;
  switcher.setAttribute('role', 'tablist');
  for (const v of VIEWS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.view = v.id;
    b.title = v.label;
    b.setAttribute('aria-label', v.label);
    b.innerHTML = v.icon;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      clearTimeout(openTimer);
      // On the collapsed switcher, or on the current view's button: open it (or keep it open).
      if (!switcher.classList.contains(OPEN_CLASS) || v.id === view) {
        switcher.classList.add(OPEN_CLASS);
        held = false;
        return;
      }
      switcher.classList.remove(OPEN_CLASS);
      held = true;
      setView(v.id);
    });
    switcher.appendChild(b);
  }
  // Opens once the pointer rests on it, not as it passes over on the way to the other tools.
  const armOpen = () => {
    clearTimeout(openTimer);
    openTimer = setTimeout(() => {
      if (!held && switcher.matches(':hover')) switcher.classList.add(OPEN_CLASS);
    }, HOVER_INTENT_MS);
  };
  switcher.addEventListener('mouseenter', () => { if (!held) armOpen(); });
  switcher.addEventListener('mousemove', () => { if (!held && !switcher.classList.contains(OPEN_CLASS)) armOpen(); });
  switcher.addEventListener('mouseleave', () => {
    clearTimeout(openTimer);
    held = false;
    switcher.classList.remove(OPEN_CLASS);
  });
  render();
  placeSwitcher();
}

// Downward scrolling on the cover side (left of the lyric column), not over RNPN's settings menu
// or top bar.
function onWheel(e) {
  if (view !== 'lyrics' || e.deltaY <= 0 || !has(RNP_OPEN)) return;
  const t = e.target;
  if (!(t instanceof Element) || !t.closest('#rnp-view') || t.closest(`${LYRICS}, .rnp-settings-menu, .rnp-window-topbar`)) return;
  const lyrics = document.querySelector(LYRICS)?.getBoundingClientRect();
  if (!lyrics?.width || e.clientX >= lyrics.left || !available('comment')) return;
  wheelSum += e.deltaY;
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => { wheelSum = 0; }, WHEEL_RESET_MS);
  if (wheelSum >= WHEEL_TO_COMMENTS) {
    wheelSum = 0;
    setView('comment');
  }
}

// NCM's page switches between a tab and its comments on wheel events that reach its page
// container: past the top of the comment list (its list lets them through only at scrollTop 0)
// or past the end of a tab. A trackpad swipe's momentum carries on after the list reaches its
// top, and NCM counts it, so a quick scroll up through the comments flipped back to the lyrics.
// In panel mode no wheel event reaches NCM's page container, and going back to the lyrics from
// the comments takes a new upward gesture started with the list already at its top.
function onPanelWheel(e) {
  if (!has(PANEL_CLASS) || !(e.target instanceof Element) || !e.target.closest(CONTAINER)) return;
  e.stopPropagation(); // the scrolling itself is the browser's default action, not a listener
  const now = performance.now();
  const list = view === 'comment' && e.target.closest(COMMENTS);
  if (now - lastPanelWheel > GESTURE_GAP_MS) {
    gestureAtTop = !!list && list.scrollTop <= 0;
    upSum = 0;
  }
  lastPanelWheel = now;
  if (!list || !gestureAtTop || closing || !has(READY_CLASS)) return;
  if (e.deltaY > 0) {
    gestureAtTop = false; // scrolled down: not leaving
    return;
  }
  upSum -= e.deltaY;
  if (upSum >= WHEEL_TO_LYRICS) {
    gestureAtTop = false;
    setView('lyrics');
  }
}

// NCM's own changes to its page while it is ours: it closing the page, or its tab changing.
function watch() {
  const s = getStore();
  if (!s || watching) return;
  watching = true;
  let last = vinylState();
  s.subscribe(() => {
    const now = vinylState();
    if (now === last) return;
    const prev = last;
    last = now;
    if (!has(PANEL_CLASS)) return;
    // NCM changed its tab under a shown panel: check it once NCM has rendered the change.
    if (has(READY_CLASS) && !closing) setTimeout(recheck, 0);
    if (prev.pageState === 'opened' && now.pageState !== 'opened') {
      if (closing) return; // ours; closePage() finishes it
      // NCM closed it itself: one of its links was followed.
      ++generation;
      finishClose();
      const close = document.querySelector(RNP_CLOSE);
      if (close && has(RNP_OPEN)) click(close);
    }
    // Any other change of NCM's tab (its wheel gestures are kept from its page by onPanelWheel)
    // is undone by recheck(), which puts the chosen view back.
  });
}

// A shown panel whose view NCM stopped showing, after a track change (to a song without that tab
// or comments, or one NCM re-rendered for): hidden at once, then setView runs again on the open
// page (READY_CLASS gone gets it past its early return), showing the view once NCM does, or going
// back to RNPN's lyrics if it never does.
function recheck() {
  if (!(has(PANEL_CLASS) && has(READY_CLASS) && !closing && view !== 'lyrics' && pageOpen())) return;
  if (available(view) && showing(view)) return;
  const v = view;
  body().classList.remove(READY_CLASS);
  setView(available(v) ? v : 'lyrics');
}

function start() {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }
  buildSwitcher();
  document.addEventListener('wheel', onWheel, { passive: true, capture: true });
  document.addEventListener('wheel', onPanelWheel, { passive: true, capture: true });
  // RNPN's page closing takes the panel with it.
  new MutationObserver(() => {
    if (!has(RNP_OPEN) && has(PANEL_CLASS) && view !== 'lyrics') setView('lyrics');
  }).observe(body(), { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', measure);
  setInterval(() => {
    if (!has(RNP_OPEN)) return;
    watch();
    placeSwitcher();
    if (view !== 'lyrics') measure();
    recheck();
  }, CHECK_MS);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
