// resources/lyrics/web/js/parse.js: the lyric window's port of RefinedNowPlayingNext's lyric parser
// must give exactly the object RNPN puts in window.currentLyrics.
//
// Fixtures (test/fixtures/lyrics/<name>/): raw.json is the /api/song/lyric/v1 response, expected.json
// RNPN's result, meta.json says where that came from: "live" is window.currentLyrics read from RNPN
// in NCM; "harness" is RNPN's own parse code cut unchanged from its bundle and run in Node on a real
// response; "harness-synthetic" is the same harness on a hand-made response for a branch no real
// response covered (roles, the [99:00] sentinel, yrc fallback, closest alignment, local LRC string).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLyrics, flags, cyrb53 } from '../resources/lyrics/web/js/parse.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'test/fixtures/lyrics');
const read = (...p) => JSON.parse(fs.readFileSync(path.join(DIR, ...p), 'utf8'));
const roundTrip = (x) => JSON.parse(JSON.stringify(x));

const fixtures = fs
  .readdirSync(DIR)
  .filter((d) => fs.existsSync(path.join(DIR, d, 'raw.json')))
  .sort();

test('there are fixtures, including the live one', () => {
  assert.ok(fixtures.length >= 16, `${fixtures.length} fixtures`);
  assert.ok(fixtures.some((d) => read(d, 'meta.json').source === 'live'));
});

for (const name of fixtures) {
  const meta = read(name, 'meta.json');
  test(`${name} (${meta.source}): ${meta.note}`, () => {
    const got = roundTrip(parseLyrics(read(name, 'raw.json'), meta.id));
    assert.deepEqual(got, read(name, 'expected.json'));
  });
}

test('flags', () => {
  const pure = flags(read('22829932', 'expected.json'));
  assert.deepEqual(pure, { hasTranslation: false, hasRomaji: false, hasKaraoke: false, pureMusic: true });
  const yrc = flags(read('1868553', 'expected.json'));
  assert.deepEqual(yrc, { hasTranslation: true, hasRomaji: false, hasKaraoke: true, pureMusic: false });
  const jp = flags(read('536622304', 'expected.json'));
  assert.deepEqual(jp, { hasTranslation: true, hasRomaji: true, hasKaraoke: false, pureMusic: false });
  const few = {
    lyrics: [
      { time: 0, originalLyric: '作曲: X' },
      { time: 1000, originalLyric: '此歌曲为没有填词的纯音乐，请您欣赏' },
    ],
  };
  assert.equal(flags(few).pureMusic, true);
  assert.equal(flags(null).pureMusic, false);
  assert.equal(flags({ lyrics: [] }).pureMusic, false);
});

test('responses RNPN ignores give null', () => {
  assert.equal(parseLyrics(null, '1'), null);
  assert.equal(parseLyrics({ data: -400 }, '1'), null);
});

test('yrc with no parsable line and a non-empty LRC throws, as in RNPN', () => {
  assert.throws(() => parseLyrics({ lrc: { lyric: '[00:01.00]a' }, yrc: { lyric: '{"t":0,"c":[]}' } }, '1'), TypeError);
});

test('hash is cyrb53 of the lines before the credit fix', () => {
  const raw = { lrc: { lyric: '{"c":[{"tx":"作词: "},{"tx":"Z"}]}\nline' } };
  const out = parseLyrics(raw, ' 7 ');
  assert.equal(out.lyrics[1].originalLyric, '作词: Z');
  assert.equal(out.hash, `7-${cyrb53(['歌词不支持滚动', '{"c":[{"tx":"作词: "},{"tx":"Z"}]}', 'line'].join('\\'))}`);
});
