// Hijack transform engine (src/prelude/hijack-runtime.js), run in a vm context.
// The NCM 3.1.14 web bundle is optional: set BNCM_NCM_WEBFILES to the extracted webfiles.zip
// directory (default test/fixtures/webfiles, gitignored); the tests that need it skip without it.
// To get it: unzip ~/Library/Application\ Support/com.netease.163music/Documents/webfiles.zip -d test/fixtures
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = fs.readFileSync(path.join(ROOT, 'src/prelude/hijack-runtime.js'), 'utf8');
const WEBFILES = process.env.BNCM_NCM_WEBFILES || path.join(ROOT, 'test/fixtures/webfiles');
const VENDORS_FILE = path.join(WEBFILES, 'hybrid/vendors~app~subApp.chunk.18d435e.js');
const VENDORS_URL = 'orpheus://orpheus/pub/hybrid/vendors~app~subApp.chunk.18d435e.js';
const haveVendors = fs.existsSync(VENDORS_FILE);

// Actions as plugins.collectHijacks() ships them (from the RefinedNowPlayingNext 3.0.2 and
// Apple-Musiclike-lyrics manifests).
const RNPN = {
  slug: 'RefinedNowPlayingNext', id: 'redux-dispatch-hook', prefix: 'orpheus://orpheus/pub/hybrid/vendors',
  type: 'replace', from: '"sagaEffects.put"),', to: '"sagaEffects.put"),window?.rnpDispatchHook?.(n),', code: null,
};
const AMLL = {
  slug: 'Apple-Musiclike-lyrics', id: 'redux-dispatch-hook', prefix: 'orpheus://orpheus/pub/hybrid/vendors',
  type: 'replace', from: '"sagaEffects.put"),', to: '"sagaEffects.put"),window?.amllDispatchHook?.(n),', code: null,
};
const AMLL_CSP = {
  slug: 'Apple-Musiclike-lyrics', id: 'csp-worker', prefix: 'orpheus://orpheus/app.html', type: 'replace',
  from: '<meta http-equiv="Content-Security-Policy" content="script-src ',
  to: '<meta http-equiv="Content-Security-Policy" content="script-src data: blob: ', code: null,
};

// Loads the runtime the way the test needs it; `globals` become context globals.
// Warnings from failing actions are expected in these tests.
const quiet = { log: console.log, error: console.error, warn() {} };

function load(globals = {}) {
  const ctx = vm.createContext({ console: quiet, ...globals });
  vm.runInContext(RUNTIME, ctx, { filename: 'hijack-runtime.js' });
  return ctx;
}

// Copies values out of the vm realm so assert's prototype checks pass.
const plain = (v) => JSON.parse(JSON.stringify(v));

function transform(text, url, hijacks) {
  return plain(load().__bncmTransform(text, url, hijacks));
}

test('the file defines __bncmTransform and installs nothing without the injection consts', () => {
  const ctx = load();
  assert.equal(typeof ctx.__bncmTransform, 'function');
  assert.equal(ctx.__bncmHijack, undefined);
});

test('replace is literal and replaces every occurrence', () => {
  const h = { slug: 's', id: 'x', prefix: 'orpheus://a/', type: 'replace', from: 'a.b', to: '$&[$1]' };
  assert.deepEqual(transform('a.b axb a.b', 'orpheus://a/x.js', [h]), { text: '$&[$1] axb $&[$1]', applied: ['s::x'] });
});

test('regex is global and supports ECMAScript replacement patterns', () => {
  const h = { slug: 's', id: 'r', prefix: 'orpheus://a/', type: 'regex', from: 'f\\((\\w+)\\)', to: 'g($1,$1)' };
  assert.deepEqual(transform('f(a);f(b)', 'orpheus://a/x.js', [h]), { text: 'g(a,a);g(b,b)', applied: ['s::r'] });
});

test('append goes on a new line, prepend is plain concatenation', () => {
  const src = 'x();\n//# sourceMappingURL=x.js.map';
  const r = transform(src, 'orpheus://a/x.js', [
    { slug: 's', id: 'a', prefix: 'orpheus://a/', type: 'append', code: 'window.ok=1' },
    { slug: 's', id: 'p', prefix: 'orpheus://a/', type: 'prepend', code: 'window.pre=1;' },
  ]);
  assert.equal(r.text, 'window.pre=1;' + src + '\nwindow.ok=1');
  assert.deepEqual(r.applied, ['s::a', 's::p']);
  assert.equal(transform('x();\n', 'orpheus://a/x.js', [{ slug: 's', id: 'a', prefix: 'orpheus://a/', type: 'append', code: 'y()' }]).text, 'x();\ny()');
});

test('only actions that change the text are reported; prefix must match; errors are contained', () => {
  const r = transform('abc', 'orpheus://a/x.js', [
    { slug: 's', id: 'nomatch', prefix: 'orpheus://a/', type: 'replace', from: 'zzz', to: 'y' },
    { slug: 's', id: 'other', prefix: 'orpheus://b/', type: 'replace', from: 'abc', to: 'y' },
    { slug: 's', id: 'bad', prefix: 'orpheus://a/', type: 'regex', from: '(', to: 'y' },
    { slug: 's', id: 'empty', prefix: 'orpheus://a/', type: 'replace', from: '', to: 'y' },
    { slug: 's', id: 'ok', prefix: 'orpheus://a/', type: 'replace', from: 'b', to: 'B' },
  ]);
  assert.deepEqual(r, { text: 'aBc', applied: ['s::ok'] });
});

test('RNPN redux-dispatch-hook on the real vendors~app~subApp chunk', { skip: !haveVendors && 'NCM web bundle not found' }, () => {
  const src = fs.readFileSync(VENDORS_FILE, 'utf8');
  assert.equal(src.split(RNPN.from).length - 1, 1, 'anchor occurs exactly once in NCM 3.1.14');
  const r = load().__bncmTransform(src, VENDORS_URL, [RNPN]);
  assert.deepEqual(plain(r.applied), ['RefinedNowPlayingNext::redux-dispatch-hook']);
  assert.equal(r.text.length, src.length + RNPN.to.length - RNPN.from.length);
  assert.ok(r.text.includes('return n(i,"sagaEffects.put"),window?.rnpDispatchHook?.(n),r.put('));

  // Still valid JS, and it still registers webpack chunk 12 when run.
  const ctx = vm.createContext({});
  vm.runInContext(r.text + '\n//# sourceURL=' + VENDORS_URL, ctx, { filename: VENDORS_URL });
  assert.equal(ctx.webpackJsonp.length, 1);
  assert.deepEqual(plain(ctx.webpackJsonp[0][0]), [12]);
});

test('RNPN and AMLL hooks stack in slug order on the vendors chunk', { skip: !haveVendors && 'NCM web bundle not found' }, () => {
  const src = fs.readFileSync(VENDORS_FILE, 'utf8');
  const r = load().__bncmTransform(src, VENDORS_URL, [AMLL, RNPN]);
  assert.deepEqual(plain(r.applied), ['Apple-Musiclike-lyrics::redux-dispatch-hook', 'RefinedNowPlayingNext::redux-dispatch-hook']);
  // Each replace re-anchors on `"sagaEffects.put"),`, so the later hook lands first.
  assert.ok(r.text.includes('"sagaEffects.put"),window?.rnpDispatchHook?.(n),window?.amllDispatchHook?.(n),r.put('));
  new vm.Script(r.text);
});

// A minimal DOM: enough for the observer, the insertion wrappers and the report.
function fakeDom({ files, hijacks, href = 'orpheus://orpheus/app.html', cfg = { 'mac.bypassCSP': 'true' } }) {
  const reports = [];
  const timers = [];
  let observer = null;
  class Node {
    constructor(nodeName) { this.nodeName = nodeName; this.children = []; this.isConnected = true; }
    appendChild(n) { this.children.push(n); if (n.nodeName === 'SCRIPT' && !n.src) n.ran = n.text; return n; }
    insertBefore(n) { return this.appendChild(n); }
  }
  class Script extends Node {
    constructor(src) { super('SCRIPT'); this.attrs = src ? { src } : {}; this.text = ''; this.events = []; }
    get src() { return this.attrs.src || ''; }
    getAttribute(k) { return this.attrs[k] ?? null; }
    removeAttribute(k) { delete this.attrs[k]; }
    dispatchEvent(e) { this.events.push(e.type); return true; }
  }
  const microtasks = [];
  const ctx = {
    Node,
    document: new Node('#document'),
    location: { href },
    MutationObserver: class { constructor(cb) { observer = cb; } observe() {} },
    XMLHttpRequest: class {
      open(m, url, sync) { this.url = url; assert.equal(sync, false); }
      send() { this.status = files[this.url] == null ? 404 : 200; this.responseText = files[this.url] ?? ''; }
    },
    Event: class { constructor(type) { this.type = type; } },
    fetch: (url, opts) => { reports.push({ url, opts }); return Promise.resolve({}); },
    setTimeout: (fn) => timers.push(fn),
    queueMicrotask: (fn) => microtasks.push(fn),
    BETTERNCM_API_PATH: 'http://127.0.0.1:1/api',
    BETTERNCM_API_KEY: 'k',
    __BNCM_TARGET__: 'T1',
    __BNCM_HIJACKS__: hijacks,
    __BNCM_SAFE__: false,
    __BNCM_CFG__: cfg,
  };
  ctx.window = ctx;
  const c = load(ctx);
  return {
    ctx: c,
    Script,
    observe: (nodes) => observer([{ addedNodes: nodes }]),
    flush() { microtasks.splice(0).forEach((f) => f()); timers.splice(0).forEach((f) => f()); },
    reports,
  };
}

test('runtime: parser-inserted script is inlined, dynamic chunk gets a load event, ids are reported', () => {
  const chunk = 'orpheus://orpheus/pub/hybrid/1.chunk.js';
  const other = 'orpheus://orpheus/pub/hybrid/2.chunk.js';
  const vendors = 'orpheus://orpheus/pub/hybrid/vendors~app.chunk.js';
  const dom = fakeDom({
    files: { [chunk]: 'a("sagaEffects.put"),b', [other]: 'nothing here', [vendors]: 'v("sagaEffects.put"),w' },
    hijacks: [
      { ...RNPN, prefix: 'orpheus://orpheus/pub/hybrid/' },
      AMLL_CSP,
    ],
  });

  // Parser-inserted.
  const s1 = new dom.Script(vendors);
  dom.observe([s1]);
  assert.equal(s1.src, '');
  assert.equal(s1.text, 'v("sagaEffects.put"),window?.rnpDispatchHook?.(n),w\n//# sourceURL=' + vendors);

  // Dynamic, matching: inlined before insertion, then a synthetic load.
  const s2 = new dom.Script(chunk);
  dom.ctx.document.appendChild(s2);
  assert.ok(s2.ran.startsWith('a("sagaEffects.put"),window?.rnpDispatchHook?.(n),b'));
  assert.deepEqual(s2.events, []);
  // Dynamic, not changed by any action: left untouched, no synthetic event.
  const s3 = new dom.Script(other);
  dom.ctx.document.insertBefore(s3, null);
  assert.equal(s3.src, other);
  // Seen by the observer after insertion: not processed twice.
  dom.observe([s2, s3]);

  dom.flush();
  assert.deepEqual(s2.events, ['load']);
  assert.deepEqual(s3.events, []);
  assert.equal(dom.reports.length, 1);
  assert.equal(dom.reports[0].url, 'http://127.0.0.1:1/api/internal/hijack_report');
  assert.equal(dom.reports[0].opts.headers['X-BNCM-Target'], 'T1');
  assert.deepEqual(JSON.parse(dom.reports[0].opts.body), {
    ids: ['Apple-Musiclike-lyrics::csp-worker', 'RefinedNowPlayingNext::redux-dispatch-hook', 'RefinedNowPlayingNext::redux-dispatch-hook'],
  });
});

test('runtime: CSP actions are not reported when bypassCSP is off', () => {
  const dom = fakeDom({ files: {}, hijacks: [AMLL_CSP], cfg: { 'mac.bypassCSP': 'false' } });
  dom.flush();
  assert.equal(dom.reports.length, 0);
});
