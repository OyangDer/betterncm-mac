// PluginMarket's 'Default' source does not work from orpheus://orpheus on macOS: the gitcode
// mirror sends no CORS header and the online Default (bncm-plugin.microblock.cc) does not
// resolve. Point a market that was never configured at GitHub (UserContent) once (DESIGN.md 4).
// The guard key keeps a later choice of the user's, including 'Default', untouched.

const SOURCE_KEY = 'plugin-market-gen2-source';
const GUARD_KEY = 'bncm-mac.seededSource';

if (!localStorage.getItem(GUARD_KEY)) {
  if (!localStorage.getItem(SOURCE_KEY)) localStorage.setItem(SOURCE_KEY, 'Github (UserContent)');
  localStorage.setItem(GUARD_KEY, '1');
}
