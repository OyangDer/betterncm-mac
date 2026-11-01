// Defaults for RefinedNowPlayingNext settings that suit a Mac better than RNPN's own.
//
// RNPN keeps each setting in localStorage under refined-now-playing-<name> and reads it when it
// loads, which is after this prelude. A setting the user has never touched has no key there, so
// writing the key first changes only the default: a value the user picked, or resets, stays.
//
// album-size: the cover is fetched at this many pixels square (RNPN's 专辑封面清晰度 slider,
// 200-800, default 200). A Retina screen draws the cover at twice its size in points, so 200
// looks soft at any cover size; 800 is the slider's top.

const DEFAULTS = {
  'refined-now-playing-album-size': '800',
};

try {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
  }
} catch { /* no storage: RNPN uses its own defaults */ }
