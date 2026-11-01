// Lyric parsing for the lyric window: a readable port of RefinedNowPlayingNext 3.0.2's own parser
// (plugins_runtime/RefinedNowPlayingNext/main.js, byte offsets B@n), so parseLyrics(raw, id) returns
// exactly the object RNPN stores as window.currentLyrics for that /api/song/lyric/v1 response,
// including our credit-line fix (src/prelude/compat-rnp-lyric-credits.js). No DOM use: it imports in
// Node and in WebKit. test/lyrics-parse.test.mjs checks it against fixtures taken from RNPN itself.
//
// Sources: Et/Lt/Rt/Mt (B@334400), Pt (B@334983, yrc path B@335428-338805), Ot/Tt/It/zt and Nt
// (B@339137), jt (B@339729), Gt (B@344682), Zt (B@345497), sn and the output object
// (B@347800-350185), N (B@294997), pure-music test (B@363300).
//
// Where the bundle differs from the written spec (the bundle wins, and this file follows it):
// - The alignment pass a() runs over the translation, romaji and LRC entries, not over the yrc
//   lines: each such entry gets `originalLyric` = the LRC text at (about) its time, and the attach
//   pass then places the entry on the yrc line whose text is closest to that by Levenshtein.
// - yrc word split: the first of several parts gets a leading space when the trimmed word starts
//   with whitespace (it never does, since the word was trimStart()ed, but the test is kept).
// - The CJK regex has a capture group and the `g` flag; the no-yrc path runs jt() twice (durations
//   are written through the first result, the second result is returned).
// - The Levenshtein memo object (At) is read but never written in the bundle, so it is omitted.
// - The hash is taken before the credit-line fix runs (RNPN hashes, then dispatches
//   'lyrics-updated', and our capture listener rewrites the lines in that same object).
// - RNPN returns its shared pure-music constant Et; this returns a fresh copy each time.
// - As in RNPN, a response with yrc but no parsable yrc line and a non-empty LRC throws (the attach
//   pass reads o[0] of an empty list); RNPN then keeps the previous lyrics, callers should too.

const PURE_MUSIC_TIME = 5940000; // 594e4
const pureMusic = () => [{ time: 0, duration: PURE_MUSIC_TIME, originalLyric: '纯音乐，请欣赏' }];

// Lt: Levenshtein distance.
function levenshtein(a, b) {
  if (a === undefined) a = '';
  if (b === undefined) b = '';
  const la = a.length;
  const lb = b.length;
  const d = [];
  for (let i = 0; i <= la; i++) (d[i] = []), (d[i][0] = i);
  for (let j = 0; j <= lb; j++) d[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      if (a[i - 1] === b[j - 1]) d[i][j] = d[i - 1][j - 1];
      else d[i][j] = Math.min(d[i - 1][j - 1] + 1, d[i][j - 1] + 1, d[i - 1][j] + 1);
    }
  }
  return d[la][lb];
}

// Rt: the line is Latin once punctuation and symbols are removed.
const isLatinLine = (s) => !!s.replace(/[\p{P}\p{S}]/gu, '').match(/^[\s\wÀ-ɏ]+$/u);

// Mt: full-width and curly punctuation to ASCII.
const asciiPunct = (s) =>
  s
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/，/g, ',')
    .replace(/！/g, '!')
    .replace(/？/g, '?')
    .replace(/：/g, ':')
    .replace(/；/g, ';');

const YRC_LINE = /^\[(?<time>[0-9]+),(?<duration>[0-9]+)\](?<line>.*)/; // Ot
const YRC_WORD = /^\((?<time>[0-9]+),(?<duration>[0-9]+),(?<flag>[0-9]+)\)(?<word>[^\(]*)/; // Tt
const LRC_TAG = /^\[((?<min>[0-9]+):)?(?<sec>[0-9]+([\.:]([0-9]+))?)\]/; // It
const LRC_DISCRIMINATOR = /^\[((?<min>[0-9]+):)?(?<sec>[0-9]+([\.:]([0-9]+))?)\-(?<discriminator>[0-9]+)\]/; // zt

// Nt: LRC text -> [{time, lyric}] sorted by time, or the unsynced form.
function parseLrc(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    const times = [];
    for (;;) {
      const m = line.match(LRC_TAG);
      if (!m) break;
      const min = Number(m.groups?.min || '0');
      const sec = Number(m.groups?.sec.replace(/:/, '.') || '0');
      times.push(Math.floor(1000 * (60 * min + sec)));
      line = line.slice(0, m.index) + line.slice((m.index || 0) + m[0].length);
      line = line.trim();
    }
    line = line.trim();
    for (const time of times) out.push({ time, lyric: line });
  }
  if (out.length === 0 && text.trim().length > 0) return parseUnsynced(text);
  return out.sort((a, b) => a.time - b.time);
}

function parseUnsynced(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length && !line.match(LRC_DISCRIMINATOR)) out.push({ time: 999999999, lyric: line, unsynced: true });
  }
  if (out.length) out.unshift({ time: 0, lyric: '歌词不支持滚动', unsynced: true });
  return out;
}

// jt: final filter.
function finalize(lines) {
  if (lines.length > 0 && lines[lines.length - 1].time === PURE_MUSIC_TIME && lines[lines.length - 1].duration === 0) {
    return pureMusic();
  }
  const kept = [];
  let lastWasEmpty = false;
  lines.forEach((line, i, all) => {
    if (line.originalLyric.trim().length === 0) {
      const next = all[i + 1];
      if (next && next.time - line.time > 5000 && !lastWasEmpty) {
        kept.push(line);
        lastWasEmpty = true;
      }
    } else {
      lastWasEmpty = false;
      kept.push(line);
    }
  });
  while (kept[0]?.originalLyric.length === 0) kept.shift();
  if (kept[0]?.time > 5000) kept.unshift({ time: 500, duration: kept[0]?.time - 500, originalLyric: '' });
  for (let i = 0; i < kept.length; i++) {
    const line = kept[i];
    if (isLatinLine(line?.originalLyric)) {
      if (line?.dynamicLyric) {
        for (let j = 0; j < line.dynamicLyric.length; j++) line.dynamicLyric[j].word = asciiPunct(line.dynamicLyric[j].word);
      }
      if (line?.originalLyric) line.originalLyric = asciiPunct(line.originalLyric);
    }
  }
  return kept;
}

// yrc text -> lines with per-word timing (the inner function of Pt).
function parseYrc(text) {
  const out = [];
  for (const raw of text.trim().split('\n')) {
    let rest = raw.trim();
    const lm = rest.match(YRC_LINE);
    if (!lm) continue;
    const lineTime = parseInt(lm.groups?.time || '0');
    const lineDuration = parseInt(lm.groups?.duration || '0');
    rest = lm.groups?.line || '';
    const words = [];
    while (rest.length > 0) {
      const wm = rest.match(YRC_WORD);
      if (!wm) break;
      const time = parseInt(wm.groups?.time || '0');
      const duration = parseInt(wm.groups?.duration || '0');
      const flag = parseInt(wm.groups?.flag || '0');
      const word = wm.groups?.word.trimStart();
      const parts = word?.split(/\s+/).filter((p) => p.trim().length > 0);
      if (parts) {
        const each = duration / parts.length;
        parts.forEach((part, k) => {
          const w = word ?? '';
          let text;
          if (k === parts.length - 1) text = /\s/.test(w[w.length - 1]) ? `${part.trimStart()} ` : part.trimStart();
          else if (k === 0) text = /\s/.test(w[0]) ? ` ${part.trimStart()}` : part.trimStart();
          else text = `${part.trimStart()} `;
          words.push({ time: time + k * each, duration: each, flag, word: text });
        });
      }
      // Bundle: e.slice(t.index||0+t[0].length); index is always 0 here, so this is t[0].length.
      rest = rest.slice(wm.index || 0 + wm[0].length);
    }
    out.push({
      time: lineTime,
      duration: lineDuration,
      originalLyric: words.map((w) => w.word).join(''),
      dynamicLyric: words,
      dynamicLyricTime: lineTime,
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

const CJK = /([\p{Unified_Ideograph}|぀-ゟ|゠-ヿ])/gu;

// Pt: build the line list from LRC, translation, romaji and yrc text.
function buildLines(lrc, trans = '', roma = '', yrc = '') {
  if (yrc.trim().length === 0) {
    const lines = parseLrc(lrc).map((e) => ({
      time: e.time,
      originalLyric: e.lyric,
      duration: 0,
      ...(e.unsynced ? { unsynced: true } : {}),
    }));
    parseLrc(trans).forEach((e) => {
      const line = lines.find((l) => l.time === e.time);
      if (line) line.translatedLyric = e.lyric;
    });
    parseLrc(roma).forEach((e) => {
      const line = lines.find((l) => l.time === e.time);
      if (line) line.romanLyric = e.lyric;
    });
    lines.sort((a, b) => a.time - b.time);
    const first = finalize(lines);
    for (let i = 0; i < first.length; i++) if (i < first.length - 1) first[i].duration = first[i + 1].time - first[i].time;
    return finalize(lines);
  }

  const lines = parseYrc(yrc);
  const lrcEntries = parseLrc(lrc);

  // a(): give each entry the LRC text at its time ("equal": last entry within 20 ms;
  // "closest" when under 10% of the entry times appear in the LRC).
  const align = (entries) => {
    let mode = 'equal';
    const own = new Set(entries.map((e) => e.time));
    const lrcTimes = new Set(lrcEntries.map((e) => e.time));
    if (new Set([...own].filter((t) => lrcTimes.has(t))).size / own.size < 0.1) mode = 'closest';
    lrcEntries.forEach((l) => {
      let target = null;
      if (mode === 'equal') {
        target = ((list, pred) => {
          for (let i = list.length - 1; i >= 0; i--) if (pred(list[i], i, list)) return list[i];
          return null;
        })(entries, (e) => Math.abs(e.time - l.time) < 20);
      } else {
        entries.forEach((e) => {
          if (target) {
            if (Math.abs(target.time - l.time) > Math.abs(e.time - l.time)) target = e;
          } else target = e;
        });
      }
      if (target) {
        target.originalLyric = target.originalLyric || '';
        if (target.originalLyric.length > 0) target.originalLyric += ' ';
        target.originalLyric += l.lyric;
      }
    });
    return entries;
  };

  // l(): put each entry's text on the yrc line near it in time whose text is closest.
  const attach = (entries, key) => {
    entries.forEach((e) => {
      let best = 0;
      lines.forEach((l, i) => {
        if (Math.abs(lines[best].time - e.time) > Math.abs(l.time - e.time)) best = i;
      });
      let candidates = [best];
      for (let k = 1; k <= 5; k++) {
        if (best - k >= 0) candidates.push(best - k);
        if (best + k < lines.length) candidates.push(best + k);
      }
      candidates = candidates.reverse();
      let score = 1e9;
      for (const i of candidates) {
        const l = lines[i];
        const s = 1000 * levenshtein(e.originalLyric, l.originalLyric) + (l[key] ? 1 : 0);
        if (s < score) (score = s), (best = i);
      }
      const line = lines[best];
      line[key] = line[key] || '';
      if (line[key].length > 0) line[key] += ' ';
      line[key] += e.lyric;
    });
  };

  const transEntries = align(parseLrc(trans));
  const romaEntries = align(parseLrc(roma));
  const rawEntries = align(parseLrc(lrc));
  attach(transEntries, 'translatedLyric');
  attach(romaEntries, 'romanLyric');
  attach(rawEntries, 'rawLyric');

  // Interludes of 5 s or more between two sung lines.
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i];
    const b = lines[i + 1];
    if (a && b && a.originalLyric.trim().length > 0 && b.originalLyric.trim().length > 0 && a.duration > 0) {
      const end = (a?.dynamicLyricTime || a.time) + a.duration;
      let start = b.time;
      if (b.dynamicLyricTime && start > b.dynamicLyricTime) start = b.dynamicLyricTime;
      if (start - end >= 5000) lines.splice(i + 1, 0, { time: end, originalLyric: '', duration: start - end });
    }
  }

  // Restore the spaces between words from the LRC text.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let raw = line.rawLyric?.trim() ?? '';
    const words = line.dynamicLyric || [];
    for (let j = 0; j < words.length; j++) {
      const w = words[j].word.trimEnd();
      if (!raw.startsWith(w)) break;
      raw = raw.substring(w.length);
      const ws = raw.match(/^\s+/);
      if (ws) {
        raw = raw.substring(ws[0].length);
        if (!words[j].word.match(/\s$/)) words[j].word += ' ';
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const words = lines[i].dynamicLyric || [];
    for (let j = 0; j < words.length; j++) {
      if (words[j]?.word?.match(CJK)) words[j].isCJK = true;
      if (words[j]?.word?.match(/\s$/)) words[j].endsWithSpace = true;
    }
  }

  // trailing: in each phrase, the last real word lasting 1 s or more.
  for (let i = 0; i < lines.length; i++) {
    const words = lines[i].dynamicLyric || [];
    const bounds = [-1];
    for (let j = 0; j < words.length - 1; j++) {
      if (words[j]?.endsWithSpace || words[j]?.word?.match(/[\,\.，。\!\?？、；：…—\~～·‘’“”ﾞ]/)) {
        if (!words[j]?.word?.match(/[a-zA-Z]+(\'‘’)*[a-zA-Z]*/)) bounds.push(j);
      }
    }
    bounds.push(words.length - 1);
    for (let b = bounds.length - 1; b >= 1; b--) {
      let last = null;
      for (let k = bounds[b]; k > bounds[b - 1]; k--) {
        const w = words[k].word.trim();
        if (!w.match(/[\p{P}\p{S}]/gu) && !w.match(/^\s*$/)) {
          last = k;
          break;
        }
      }
      if (last === null) continue;
      const word = words[last];
      if (word.duration >= 1000) word.trailing = true;
    }
  }
  return finalize(lines);
}

// Gt: response -> lines, falling back to the no-yrc path when the yrc covers too few lines.
function linesFromResponse(e) {
  if (!e) return null;
  e.lrc || (e.lrc = {});
  const lrc = (e?.lrc?.lyric ?? '').replace(/　/g, ' ');
  const trans = e?.ytlrc?.lyric ?? e?.ttlrc?.lyric ?? e?.tlyric?.lyric ?? '';
  const roma = e?.yromalrc?.lyric ?? e?.romalrc?.lyric ?? '';
  const yrc = e?.yrc?.lyric ?? '';
  const tags = lrc.match(/\[(.*?)\]/g)?.length ?? 0;
  const lines = buildLines(lrc, trans, roma, yrc);
  return tags - lines.length > 0.7 * tags ? buildLines(lrc, trans, roma) : lines;
}

// Zt
function markInterludes(lines) {
  for (const line of lines ?? []) if (line.originalLyric === '') line.isInterlude = true;
  return lines ?? [];
}

// N: cyrb53.
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// compat-rnp-lyric-credits.js
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

function fixCredits(result) {
  for (const line of result?.lyrics ?? []) {
    for (const key of ['originalLyric', 'lyric']) {
      const text = creditText(line?.[key]);
      if (text != null) line[key] = text;
    }
  }
}

// sn + the output object. `raw` is the lyric API response (or an LRC string, as RNPN's local
// lyric path); `id` the track id the hash is built with. Returns null where RNPN ignores the
// response (falsy, or data == -400). Mutates `raw` the way RNPN does (adds an empty lrc).
export function parseLyrics(raw, id) {
  if (!raw || raw?.data === -400) return null;
  let r = raw;
  if (typeof raw === 'string') r = { lrc: { lyric: raw }, source: { name: 'Local' } };
  const key = String(id ?? '').trim() || '0';
  const lines = markInterludes(linesFromResponse(r) ?? []);

  const out = { lyrics: lines, contributors: {} };
  if (lines[0]?.unsynced) out.unsynced = true;
  if (r?.lyricUser) out.contributors.original = { name: r.lyricUser.nickname, userid: r.lyricUser.userid };
  if (r?.transUser) out.contributors.translation = { name: r.transUser.nickname, userid: r.transUser.userid };
  out.contributors.roles = (r?.roles ?? []).filter(
    (e) => !(e.artistMetaList?.length === 1 && e.artistMetaList[0]?.artistId === 0)
  );
  const roles = out.contributors.roles;
  for (let i = 0; i < roles.length; i += 1) {
    const list = JSON.stringify(roles[i].artistMetaList);
    for (let j = i + 1; j < roles.length; j += 1) {
      if (JSON.stringify(roles[j].artistMetaList) === list) {
        roles[i].roleName += ` / ${roles[j].roleName}`;
        roles.splice(j, 1);
        j -= 1;
      }
    }
  }
  if (r?.source) out.contributors.lyricSource = r.source;
  out.hash = `${key}-${cyrb53(lines.map((l) => l.originalLyric).join('\\'))}`;
  fixCredits(out);
  return out;
}

// What the lyric view's switches and click-to-seek need.
export function flags(parsed) {
  const lines = parsed?.lyrics ?? [];
  return {
    hasTranslation: lines.some((l) => l.translatedLyric),
    hasRomaji: lines.some((l) => l.romanLyric),
    hasKaraoke: lines.some((l) => l.dynamicLyric),
    pureMusic: lines.length > 0 && (lines.length === 1 || (lines.length <= 10 && lines.some((l) => (l.originalLyric ?? '').includes('纯音乐')))),
  };
}
