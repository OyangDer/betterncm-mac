// Readable credit lines in RefinedNowPlayingNext's unsynced lyrics.
//
// NCM puts credits at the top of a song's lyric as JSON lines such as
// {"t":0,"c":[{"tx":"作词: "},{"tx":"ひまわりP"}]}. RNPN's timed-lyric parser drops them (they
// carry no [mm:ss] tag), but for a lyric without timestamps it shows every line as it is, JSON
// included. RNPN announces each parsed lyric with a 'lyrics-updated' event whose detail is
// window.currentLyrics, which its lyric view also reads on mount; this rewrites such lines in
// that object to the text NCM itself shows ("作词: ひまわりP") before RNPN's listeners see it.
// A capture listener on window runs before any listener on document.

function creditText(s) {
  if (typeof s !== 'string' || s[0] !== '{' || s[s.length - 1] !== '}') return null;
  try {
    const parts = JSON.parse(s)?.c;
    if (!Array.isArray(parts)) return null;
    const text = parts.map((p) => (typeof p?.tx === 'string' ? p.tx : '')).join('').trim();
    return text || null;
  } catch {
    return null;
  }
}

function fixLyrics(lyrics) {
  for (const line of lyrics?.lyrics ?? []) {
    for (const key of ['originalLyric', 'lyric']) {
      const text = creditText(line?.[key]);
      if (text != null) line[key] = text;
    }
  }
}

window.addEventListener('lyrics-updated', (e) => fixLyrics(e.detail), true);
