// src/prelude/compat-rnp-lyric-credits.js: NCM's JSON credit lines in RNPN's parsed lyrics
// become plain text before RNPN's listeners see them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = fs.readFileSync(path.join(ROOT, 'src/prelude/compat-rnp-lyric-credits.js'), 'utf8');

function load() {
  let listener = null;
  const win = { addEventListener: (t, fn, capture) => { if (t === 'lyrics-updated' && capture) listener = fn; } };
  vm.runInContext(CODE, vm.createContext({ window: win }));
  return (detail) => listener({ detail });
}

test('credit lines become their text; other lines are untouched', () => {
  const fire = load();
  const lyrics = {
    unsynced: true,
    lyrics: [
      { originalLyric: '歌词不支持滚动' },
      { originalLyric: '{"c":[{"tx":"作词: "},{"tx":"ひまわりP"}]}' },
      { originalLyric: '{"t":0,"c":[{"tx":"作曲: ","li":null},{"tx":"ひまわりP"}]}' },
      { originalLyric: '風に揺れる カーテンの' },
      { originalLyric: '{not json}' },
      { originalLyric: '{"c":"x"}' },
    ],
  };
  fire(lyrics);
  assert.deepEqual(lyrics.lyrics.map((l) => l.originalLyric), [
    '歌词不支持滚动', '作词: ひまわりP', '作曲: ひまわりP', '風に揺れる カーテンの', '{not json}', '{"c":"x"}',
  ]);
});

test('no lyrics, no error', () => {
  const fire = load();
  assert.doesNotThrow(() => fire(null));
  assert.doesNotThrow(() => fire({}));
});
