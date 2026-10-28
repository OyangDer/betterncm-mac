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

function load({ rnp = true, rnpOpen = false, collapseWorksAfter = 0 } = {}) {
  const log = [];
  const timers = [];
  let observerCb = null;
  let onVisible = null;
  const bodyClasses = new Set(rnpOpen ? ['rnp-lyric-page-open'] : []);
  const styleProps = {};
  let collapseClicks = 0;
  const collapse = {
    dispatchEvent: () => {
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
  const cover = { dispatchEvent: () => { log.push('open-rnp'); bodyClasses.add('rnp-lyric-page-open'); } };
  const ctx = {
    loadedPlugins: rnp ? { RefinedNowPlayingNext: {} } : {},
    getComputedStyle: () => ({ display: page.display }),
    MouseEvent: class { constructor(type) { this.type = type; } },
    MutationObserver: class { constructor(cb) { observerCb = cb; } observe() {} disconnect() {} },
    setTimeout: (fn) => { timers.push(fn); },
    setInterval: () => {},
    console: { warn: () => log.push('warn') },
    document: {
      hidden: false,
      querySelector: (sel) => (sel === '#vinyl-page-container' ? container : sel === 'footer .miniVinylWrapper' ? cover : null),
      addEventListener: (t, fn) => { if (t === 'visibilitychange') onVisible = fn; },
      body: { classList: { contains: (c) => bodyClasses.has(c) }, appendChild: () => {} },
    },
  };
  ctx.window = ctx;
  vm.runInContext(CODE, vm.createContext(ctx));
  const open = () => { page.display = 'block'; observerCb?.(); };
  const flush = () => { for (let i = 0; i < 50 && timers.length; i++) timers.shift()(); };
  const setHidden = (h) => { ctx.document.hidden = h; if (!h) onVisible?.(); };
  return { log, open, flush, styleProps, page, setHidden };
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
