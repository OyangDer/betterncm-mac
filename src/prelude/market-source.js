// PluginMarket's 'Default' source does not work from orpheus://orpheus on macOS: the gitcode
// mirror sends no CORS header (and now answers 403 to everyone) and the online Default
// (bncm-plugin.microblock.cc) does not resolve. Point a market that was never configured at
// GitHub (UserContent) once (DESIGN.md 4). The guard key keeps a later choice of the user's,
// including 'Default', untouched.
//
// GitHub itself is often slow or unreachable from mainland China. Requests for the packed-plugins
// repo, from any of the sources below, go to GitHub first and, if it fails or does not answer
// within GITHUB_TIMEOUT_MS, to the same files on jsDelivr (it sends CORS headers; its copy can
// lag GitHub by a few hours). After a network failure GitHub is skipped for GITHUB_RETRY_MS, but
// an error from jsDelivr (it refuses files over 20 MB) still gets one more GitHub try.

const SOURCE_KEY = 'plugin-market-gen2-source';
const GUARD_KEY = 'bncm-mac.seededSource';

if (!localStorage.getItem(GUARD_KEY)) {
  if (!localStorage.getItem(SOURCE_KEY)) localStorage.setItem(SOURCE_KEY, 'Github (UserContent)');
  localStorage.setItem(GUARD_KEY, '1');
}

const REPO_PREFIXES = [
  'https://raw.githubusercontent.com/BetterNCM/BetterNCM-Packed-Plugins/master/',
  'https://github.com/BetterNCM/BetterNCM-Packed-Plugins/raw/master/',
  'https://raw.gitcode.com/intensity/bncm-plugin-packed/raw/master/',
  'https://bncm-plugin.microblock.cc/', // 'Default' once the online source list has loaded
];
const GITHUB = REPO_PREFIXES[0];
const JSDELIVR = 'https://cdn.jsdelivr.net/gh/BetterNCM/BetterNCM-Packed-Plugins@master/';
const GITHUB_TIMEOUT_MS = 8000; // until the response headers; the body may take longer
const GITHUB_RETRY_MS = 5 * 60 * 1000;

const nativeFetch = window.fetch;
let githubDownUntil = 0;

// The timeout only covers the wait for headers, so a slow but working download is not cut off;
// the caller's own signal still aborts it at any point.
async function fetchGithub(url, init) {
  const ctl = new AbortController();
  const outer = init && init.signal;
  if (outer) {
    if (outer.aborted) ctl.abort(outer.reason);
    else outer.addEventListener('abort', () => ctl.abort(outer.reason), { once: true });
  }
  const timer = setTimeout(() => ctl.abort(new DOMException('GitHub did not answer', 'TimeoutError')), GITHUB_TIMEOUT_MS);
  try {
    return await nativeFetch.call(window, url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

window.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : null;
  const prefix = url && REPO_PREFIXES.find((p) => url.startsWith(p));
  if (!prefix) return nativeFetch.call(window, input, init);
  const rest = url.slice(prefix.length);
  const skippedGithub = Date.now() < githubDownUntil;
  if (!skippedGithub) {
    try {
      const res = await fetchGithub(GITHUB + rest, init);
      if (res.ok) return res;
      console.warn(`[BetterNCM] GitHub answered ${res.status} for ${rest}; trying jsDelivr`);
    } catch (e) {
      if (init && init.signal && init.signal.aborted) throw e;
      console.warn(`[BetterNCM] GitHub failed for ${rest} (${e && e.message}); using jsDelivr for a while`);
      githubDownUntil = Date.now() + GITHUB_RETRY_MS;
    }
  }
  const res = await nativeFetch.call(window, JSDELIVR + rest, init);
  if (res.ok || !skippedGithub) return res;
  try {
    const gh = await fetchGithub(GITHUB + rest, init);
    if (gh.ok) {
      githubDownUntil = 0;
      return gh;
    }
  } catch (e) {
    if (init && init.signal && init.signal.aborted) throw e;
  }
  return res;
};
