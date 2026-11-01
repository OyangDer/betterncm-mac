// The accent colours from the cover, RNPN's way (accent-core.js, a port of its `wg`). The pixels are
// sampled in NCM's page, by Chromium, exactly as RNPN samples them: WebKit's drawImage scales
// differently enough to change the colour. The modal outcome of RNPN's randomised clustering is
// used, so a song gets the same colours every time.
import { request } from './bus.js';
import { computeAccentModal } from './accent-core.js';

const cache = new Map(); // url|variant -> vars
const inflight = new Map(); // url|variant -> promise of vars
let applied = '';
let wanted = ''; // the latest request: an older cover finishing later must not win

function decode(b64) {
  const bin = atob(b64);
  const px = new Array(bin.length / 4);
  for (let i = 0, j = 0; i < bin.length; i += 4, j++) {
    // ARGB as RNPN builds it: ((a<<24)>>>0 | r<<16 | g<<8 | b) >>> 0
    px[j] = (((bin.charCodeAt(i + 3) << 24) >>> 0) | (bin.charCodeAt(i) << 16) | (bin.charCodeAt(i + 1) << 8) | bin.charCodeAt(i + 2)) >>> 0;
  }
  return px;
}

/** url: the cover URL exactly as RNPN's <img> had it; variant: off | primary | secondary | tertiary. */
export async function applyAccentFor(url, variant) {
  if (!url) return;
  const v = variant === 'off' ? 'primary' : variant;
  const key = `${url}|${v}`;
  wanted = key;
  let vars = cache.get(key);
  if (!vars) {
    if (!inflight.has(key)) {
      inflight.set(key, request('accentPixels', { url }, 10000)
        .then((b64) => computeAccentModal(decode(b64), v, 12).vars)
        .finally(() => inflight.delete(key)));
    }
    vars = await inflight.get(key);
    cache.set(key, vars);
    if (cache.size > 40) cache.delete(cache.keys().next().value);
  }
  if (wanted !== key || applied === key) return;
  applied = key;
  for (const [k, val] of Object.entries(vars)) document.body.style.setProperty(k, val);
}
