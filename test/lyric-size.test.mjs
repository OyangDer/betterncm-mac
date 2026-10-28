// src/prelude/compat-rnp-lyric-size.js in a vm context with a fake page: the size RNPN is sent
// for a window size, and slider events setting the base.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = fs.readFileSync(path.join(ROOT, 'src/prelude/compat-rnp-lyric-size.js'), 'utf8');

function load({ w, h, setting = '53', mounted = true }) {
  const listeners = {};
  const winListeners = {};
  const timers = [];
  const sent = [];
  const lyrics = { style: { fontSize: `${setting}px` } };
  const page = {
    innerWidth: w, innerHeight: h,
    screen: { width: 1470, height: 956 },
    localStorage: { getItem: (k) => (k === 'refined-now-playing-lyric-font-size' ? setting : null) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    document: {
      querySelector: () => (mounted ? lyrics : null),
      addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
      dispatchEvent: (e) => {
        sent.push(e.detail);
        lyrics.style.fontSize = `${e.detail}px`; // what RNPN does
        for (const fn of listeners[e.type] || []) fn(e);
      },
    },
    addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    setInterval: (fn) => { page.__tick = fn; return 1; },
  };
  page.window = page;
  vm.runInContext(CODE, vm.createContext(page));
  const flush = () => { while (timers.length) timers.shift()(); };
  return { page, sent, lyrics, flush, fire: (t, e) => (listeners[t] || []).forEach((fn) => fn(e)), resize: () => (winListeners.resize || []).forEach((fn) => fn()) };
}

test('full-screen window keeps the setting; smaller ones scale by the smaller ratio', () => {
  const full = load({ w: 1470, h: 956 });
  full.page.__tick();
  assert.deepEqual(full.sent, [], 'already at 53px');
  const small = load({ w: 1066, h: 752 });
  small.page.__tick();
  assert.deepEqual(small.sent, [38]); // 53 * min(0.725, 0.787)
});

test('never above the setting, never below half of it or 16px', () => {
  const big = load({ w: 3000, h: 2000 });
  big.page.__tick();
  assert.deepEqual(big.sent, []);
  const tiny = load({ w: 300, h: 200 });
  tiny.page.__tick();
  assert.deepEqual(tiny.sent, [27]); // 53 * 0.5
  const tinySmallBase = load({ w: 300, h: 200, setting: '20' });
  tinySmallBase.page.__tick();
  assert.deepEqual(tinySmallBase.sent, [16]);
});

test('nothing is sent while the lyric view is not mounted', () => {
  const p = load({ w: 1066, h: 752, mounted: false });
  p.page.__tick();
  p.resize();
  p.flush();
  assert.deepEqual(p.sent, []);
});

test('a slider value becomes the base and is scaled right after', () => {
  const p = load({ w: 1066, h: 752 });
  p.fire('rnp-lyric-font-size', { type: 'rnp-lyric-font-size', detail: '60' });
  p.lyrics.style.fontSize = '60px'; // RNPN applied the raw value
  p.flush();
  assert.deepEqual(p.sent, [44]); // 60 * 0.725 = 43.5
  assert.equal(p.lyrics.style.fontSize, '44px');
});

test('a resize re-sends the scaled size', () => {
  const p = load({ w: 1470, h: 956 });
  p.page.innerWidth = 1066;
  p.page.innerHeight = 752;
  p.resize();
  p.flush();
  assert.deepEqual(p.sent, [38]);
});
