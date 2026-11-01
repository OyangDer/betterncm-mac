// The lyrics window's settings: schema coercion and the one-time carry-over from RNPN's keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// settings.js imports bus.js, which talks to the host through window.webkit
globalThis.window = { addEventListener() {}, webkit: { messageHandlers: { b: { postMessage() {} } } } };
globalThis.innerWidth = 1470;
globalThis.innerHeight = 923;
const { DEFAULTS, normalize, fromRnp } = await import('../resources/lyrics/web/js/settings.js');

test('normalize keeps known keys in range and drops the rest', () => {
  const s = normalize({ fontSize: 500, accent: 'neon', blur: 'yes', zoom: true, fontList: ['  苹方 ', '', 3], bogus: 1 });
  assert.equal(s.fontSize, 72);
  assert.equal(s.accent, DEFAULTS.accent);
  assert.equal(s.blur, DEFAULTS.blur);
  assert.equal(s.zoom, true);
  assert.deepEqual(s.fontList, ['苹方']);
  assert.ok(!('bogus' in s));
  assert.deepEqual(normalize(null), { ...DEFAULTS });
});

test("RNPN's settings carry over", () => {
  // the user's keys as read from NCM's localStorage (bspec settings.md §1)
  const ls = {
    'accent-color-variant': 'secondary', 'album-size': '800', 'background-type': 'blur', 'cover-blurry-shadow': 'false',
    'current-lyric-alignment-percentage': '50', 'custom-font': 'false', 'font-family': '[]', 'gradient-bg-dynamic': 'true',
    'hide-player-controls': 'false', 'horizontal-align': 'center', 'karaoke-animation': 'float', 'lyric-animation-timing': 'smooth',
    'lyric-blur': 'true', 'lyric-contributors-display': 'hide', 'lyric-fade': 'true', 'lyric-font-size': '54', 'lyric-glow': 'true',
    'lyric-offset': '0', 'lyric-rotate': 'false', 'lyric-stagger': 'true', 'lyric-zoom': 'true', 'original-lyric-bold': 'true',
    'rectangle-cover': 'true', 'show-romaji': 'false', 'show-translation': 'false', 'song-alias-display-mode': 'alias-first',
    'static-fluid': 'true', 'text-glow': 'false', 'text-shadow': 'true', 'use-karaoke-lyrics': 'true', 'vertical-align': 'middle',
  };
  const s = fromRnp(ls);
  assert.equal(s.accent, 'secondary');
  assert.equal(s.coverShadow, 'plain');
  assert.equal(s.coverPos, 'center');
  assert.equal(s.contributors, 'hide');
  assert.equal(s.fontSize, 54);
  assert.equal(s.textEffect, 'shadow');
  assert.equal(s.showTranslation, false);
  assert.equal(s.karaoke, true);
  assert.equal(s.blur && s.fade && s.zoom, true);
  assert.equal(s.translationEm, 0, "RNPN's default 1em becomes our automatic size");
  assert.equal(s.subtitle, 'alias');
  assert.equal(s.bgType, 'blur');
});

test('mixed and missing RNPN values map sensibly', () => {
  assert.equal(fromRnp({ 'horizontal-align': 'left', 'vertical-align': 'bottom' }).coverPos, 'bottomLeft');
  assert.equal(fromRnp({ 'text-glow': 'true', 'text-shadow': 'true' }).textEffect, 'glow');
  assert.equal(fromRnp({ 'hide-song-alias-name': 'true', 'song-alias-display-mode': 'both' }).subtitle, 'none');
  assert.equal(fromRnp({ 'background-type': 'fluid' }).bgType, 'blur');
  assert.equal(fromRnp({ 'current-lyric-alignment-percentage': '30' }).alignment, 30);
  assert.equal(fromRnp({ 'lyric-translation-size-em': '0.8' }).translationEm, 0.8);
  assert.deepEqual(fromRnp({ 'custom-font': 'true', 'font-family': '["思源黑体","苹方"]' }).fontList, ['思源黑体', '苹方']);
  assert.deepEqual(fromRnp({}), { ...DEFAULTS });
});
