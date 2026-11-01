// src/prelude/compat-rnp-native-page.js in a vm context with a fake page: the stock vinyl page
// opening is swapped for RNPN's page and collapsed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = fs.readFileSync(path.join(ROOT, 'src/prelude/compat-rnp-native-page.js'), 'utf8');
const BUTTON_RECT = { left: 40, top: 33, width: 40, height: 40 };

function load({ rnp = true, rnpOpen = false, collapseWorksAfter = 0, frames = false, buttonRect = BUTTON_RECT } = {}) {
  const log = [];
  const timers = [];
  const frameQueue = [];
  const clicks = [];
  let observerCb = null;
  let onVisible = null;
  const listeners = {};
  const bodyClasses = new Set(rnpOpen ? ['rnp-lyric-page-open'] : []);
  const styleProps = {};
  let collapseClicks = 0;
  const collapse = {
    getBoundingClientRect: () => buttonRect,
    dispatchEvent: (e) => {
      clicks.push(e);
      collapseClicks++;
      log.push('collapse');
      if (collapseClicks > collapseWorksAfter) page.display = 'none';
    },
  };
  const page = { display: 'none' };
  const container = {
    style: { setProperty: (k, v) => { styleProps[k] = v; }, removeProperty: (k) => { delete styleProps[k]; } },
    querySelector: () => collapse,
  };
  const cover = {
    getBoundingClientRect: () => ({ left: 20, top: 840, width: 60, height: 60 }),
    dispatchEvent: () => { log.push('open-rnp'); bodyClasses.add('rnp-lyric-page-open'); },
  };
  const ctx = {
    loadedPlugins: rnp ? { RefinedNowPlayingNext: {} } : {},
    getComputedStyle: () => ({ display: page.display }),
    MouseEvent: class { constructor(type, init = {}) { this.type = type; this.clientX = init.clientX ?? 0; this.clientY = init.clientY ?? 0; } },
    innerWidth: 1470,
    innerHeight: 923,
    ...(frames ? { requestAnimationFrame: (fn) => { frameQueue.push(fn); } } : {}),
    MutationObserver: class { constructor(cb) { observerCb = cb; } observe() {} disconnect() {} },
    setTimeout: (fn) => { timers.push(fn); },
    setInterval: () => {},
    console: { warn: () => log.push('warn') },
    document: {
      hidden: false,
      querySelector: (sel) => (sel === '#vinyl-page-container' ? container : sel === 'footer .miniVinylWrapper' ? cover : null),
      addEventListener: (t, fn) => { if (t === 'visibilitychange') onVisible = fn; else (listeners[t] ||= []).push(fn); },
      body: { classList: { contains: (c) => bodyClasses.has(c) }, appendChild: () => {} },
    },
  };
  ctx.window = ctx;
  vm.runInContext(CODE, vm.createContext(ctx));
  const open = () => { page.display = 'block'; observerCb?.(); };
  const flush = () => { for (let i = 0; i < 50 && timers.length; i++) timers.shift()(); };
  const setHidden = (h) => { ctx.document.hidden = h; if (!h) onVisible?.(); };
  const frame = () => { const q = frameQueue.splice(0); q.forEach((fn) => fn()); };
  const close = () => { page.display = 'none'; observerCb?.(); };
  const restyle = () => observerCb?.();
  const shiftPress = () => {
    const e = { shiftKey: true, target: { closest: (sel) => (sel === '.miniVinylWrapper' ? {} : null) } };
    for (const fn of listeners.pointerdown || []) fn(e);
  };
  return { log, open, close, restyle, flush, frame, clicks, styleProps, page, setHidden, shiftPress, bodyClasses };
}

test('the stock page opening is replaced by RNPN and collapsed', () => {
  const p = load();
  p.open();
  assert.equal(p.styleProps.visibility, 'hidden', 'hidden before paint');
  assert.equal(p.styleProps.opacity, '0', 'cover image overrides visibility, so opacity too');
  p.flush();
  assert.deepEqual(p.log, ['open-rnp', 'collapse']);
  assert.equal(p.page.display, 'none');
  assert.equal(p.styleProps.visibility, undefined, 'unhidden for next time');
  assert.equal(p.styleProps.opacity, undefined);
});

test('collapse is retried while NCM is still opening the page', () => {
  const p = load({ collapseWorksAfter: 2 });
  p.open();
  p.flush();
  assert.deepEqual(p.log, ['open-rnp', 'collapse', 'collapse', 'collapse']);
  assert.equal(p.page.display, 'none');
});

test('with RNPN already open, the stock page is only collapsed', () => {
  const p = load({ rnpOpen: true });
  p.open();
  p.flush();
  assert.deepEqual(p.log, ['collapse']);
});

test('without RNPN the stock page is left alone', () => {
  const p = load({ rnp: false });
  p.open();
  p.flush();
  assert.deepEqual(p.log, []);
  assert.equal(p.page.display, 'block');
});

test('a page that will not close is shown again, not left invisible', () => {
  const p = load({ collapseWorksAfter: 99 });
  p.open();
  p.flush();
  assert.equal(p.page.display, 'block');
  assert.equal(p.styleProps.visibility, undefined);
  assert.ok(p.log.includes('warn'));
});

test('a hidden window is left until it shows, then handled', () => {
  const p = load();
  p.setHidden(true);
  p.open();
  p.flush();
  assert.deepEqual(p.log, []);
  p.setHidden(false);
  p.flush();
  assert.deepEqual(p.log, ['open-rnp', 'collapse']);
  assert.equal(p.page.display, 'none');
});

test('a page given up on is retried when the window shows again', () => {
  const p = load({ collapseWorksAfter: 12 });
  p.open();
  p.flush();
  assert.equal(p.page.display, 'block', 'gave up after the retries');
  p.setHidden(true);
  p.setHidden(false);
  p.flush();
  assert.equal(p.page.display, 'none');
});

test('clicks carry the button\'s center, not (0, 0), which RNPN takes for its moved play bar', () => {
  const p = load();
  p.open();
  p.flush();
  assert.deepEqual(p.clicks.map((e) => [e.clientX, e.clientY]), [[60, 53]]);
  const q = load({ buttonRect: { left: 0, top: 0, width: 0, height: 0 } });
  q.open();
  q.flush();
  assert.deepEqual(q.clicks.map((e) => [e.clientX, e.clientY]), [[735, 461.5]], 'not laid out: the window\'s center');
});

test('retries wait for frames, so an undrawn window does not use them up', () => {
  const p = load({ frames: true, collapseWorksAfter: 1 });
  p.open();
  p.flush();
  assert.equal(p.clicks.length, 1);
  for (let i = 0; i < 20; i++) p.flush(); // timers keep running, but no frame comes
  assert.equal(p.clicks.length, 1);
  assert.equal(p.page.display, 'block');
  assert.equal(p.styleProps.visibility, 'hidden', 'still hidden, not given up on');
  p.frame();
  assert.equal(p.clicks.length, 2);
  assert.equal(p.page.display, 'none');
  p.flush();
  p.frame();
  assert.equal(p.styleProps.visibility, undefined, 'unhidden once closed');
  assert.ok(!p.log.includes('warn'));
});

test('a shift-click opening is left alone until the page closes, however long that is', () => {
  const p = load();
  p.shiftPress();
  p.open();
  p.flush(); // the shift's time limit passes with the page open
  p.restyle();
  p.flush();
  assert.deepEqual(p.log, []);
  assert.equal(p.page.display, 'block');
  p.close();
  p.open(); // a later opening without shift is replaced again
  p.flush();
  assert.deepEqual(p.log, ['open-rnp', 'collapse']);
});

test('a shift press that opened nothing lapses', () => {
  const p = load();
  p.shiftPress();
  p.flush();
  p.open();
  p.flush();
  assert.deepEqual(p.log, ['open-rnp', 'collapse']);
});

test('the page compat-rnp-panels.js opens over RNPN is left alone', () => {
  const p = load({ rnpOpen: true });
  p.bodyClasses.add('bncm-rnp-panel');
  p.open();
  p.flush();
  assert.deepEqual(p.log, []);
  assert.equal(p.page.display, 'block');
});

test('a page compat-rnp-panels.js takes over mid-swap is left to it, shown again', () => {
  const p = load({ rnpOpen: true });
  p.open(); // swap starts: hidden, collapse queued
  p.bodyClasses.add('bncm-rnp-panel');
  p.flush();
  assert.deepEqual(p.log, []);
  assert.equal(p.page.display, 'block');
  assert.equal(p.styleProps.visibility, undefined);
  assert.equal(p.styleProps.opacity, undefined);
});
