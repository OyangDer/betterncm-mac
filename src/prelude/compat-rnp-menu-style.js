// NCM's dropdown menus, while RefinedNowPlayingNext's page is open, drawn like Apple Music's
// now-playing menus: a translucent material tinted with the cover's colour instead of NCM's
// opaque grey-blue box, text only (NCM's line icons dropped), tighter rows, rounded highlight.
//
// Every NCM dropdown is the same component (.cmd-dropdown in a .cmd-portal-inner), and with
// RNPN's page covering the window the only ones that can open are the "···" menu (moved next to
// RNPN's button by compat-rnp-menu.js) and its submenus, so the page's open class scopes this.
// RNPN puts its palette on <body> as --rnp-accent-color-*-dark; the page is always dark, so the
// dark set is used, with neutral fallbacks before RNPN has picked colours.

const STYLE_ID = 'bncm-compat-rnp-menu-style';
const OPEN = 'body.rnp-lyric-page-open';
const BG = 'var(--rnp-accent-color-bg-dark-rgb, 40, 40, 46)';
const FG = 'var(--rnp-accent-color-shade-2-dark-rgb, 255, 255, 255)';

const CSS = `
${OPEN} .cmd-portal-inner .cmd-dropdown {
  background: rgba(${BG}, 0.5) !important;
  -webkit-backdrop-filter: blur(40px) saturate(1.6);
  backdrop-filter: blur(40px) saturate(1.6);
  border: 0.5px solid rgba(${FG}, 0.16);
  border-radius: 12px !important;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.28), 0 0 0 0.5px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}
${OPEN} .cmd-portal-inner .cmd-dropdown [class*="StyledMenu_"] {
  background: transparent !important;
  padding: 5px 0 !important;
  min-width: 200px;
}
${OPEN} .cmd-portal-inner .cmd-dropdown-item {
  height: 28px !important;
  margin: 0 5px;
  border-radius: 6px;
  background: transparent !important;
  font-weight: 400 !important;
}
${OPEN} .cmd-portal-inner .cmd-dropdown-item-paragraph {
  height: 28px !important;
  padding: 0 10px !important;
}
${OPEN} .cmd-portal-inner .cmd-dropdown-item-icon { display: none !important; }
${OPEN} .cmd-portal-inner .cmd-dropdown-item-text,
${OPEN} .cmd-portal-inner .cmd-dropdown-item-paragraph {
  font-size: 14px !important;
  line-height: 28px !important;
  color: rgba(${FG}, 0.92) !important;
  font-weight: 400 !important;
}
${OPEN} .cmd-portal-inner .cmd-dropdown-item:hover { background: rgba(${FG}, 0.14) !important; }
${OPEN} .cmd-portal-inner .cmd-dropdown-item:hover .cmd-dropdown-item-text { color: rgb(${FG}) !important; }
${OPEN} .cmd-portal-inner .cmd-dropdown-item-rightIcon { color: rgba(${FG}, 0.7) !important; }
${OPEN} .cmd-portal-inner .cmd-dropdown-divider {
  height: 1px !important;
  margin: 5px 15px !important;
  padding: 0 !important;
  background: rgba(${FG}, 0.14) !important;
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
