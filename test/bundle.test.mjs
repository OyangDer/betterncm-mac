// buildInjection against a throwaway project root, evaluated in a vm sandbox that fakes the page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { buildInjection } from '../src/bundle.mjs';

let root;

const PRELUDE = {
  'polyfills.js': `window.__order.push('polyfills');`,
  'native-shim.js': `window.__order.push('native'); window.betterncm_native = { target: __BNCM_TARGET__, key: BETTERNCM_API_KEY };`,
  'hijack-runtime.js': `window.__order.push('hijack'); window.__hijacks = __BNCM_HIJACKS__;`,
  'devtools-key.js': `window.__order.push('devtools');`,
  'channel-shim.js': `window.__order.push('channel');`,
  'zz-extra.js': `window.__order.push('extra');`,
};

const FRAMEWORK = `(() => { window.__order.push('framework'); betterncm = { path: BETTERNCM_API_PATH, files: BETTERNCM_FILES_PATH }; })();
//# sourceMappingURL=data:application/json;base64,e30=`;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bncm-bundle-'));
  fs.mkdirSync(path.join(root, 'src/prelude'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  for (const [f, code] of Object.entries(PRELUDE)) fs.writeFileSync(path.join(root, 'src/prelude', f), code);
  fs.writeFileSync(path.join(root, 'dist/framework.js'), FRAMEWORK);
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

function baseOpts(extra = {}) {
  return {
    root,
    targetId: 'T1',
    apiKey: 'k'.repeat(64),
    apiPort: 4567,
    safe: false,
    cfg: { 'mac.channelShim': 'true', 'mac.bypassCSP': 'true' },
    hijacks: [{ slug: 'a', id: '0', prefix: 'orpheus://orpheus/pub/hybrid/vendors', type: 'append', code: 'x' }],
    startupScripts: [
      { slug: 'good', code: `window.__order.push('startup:good'); var goodGlobal = 1;` },
      { slug: 'broken', code: `this is not javascript (` },
      { slug: 'throws', code: `throw new Error('boom')` },
      { slug: 'after', code: `window.__order.push('startup:after');` },
    ],
    ...extra,
  };
}

// Runs the script in a fresh context shaped like a page; returns the window object.
function runPage(src, { protocol = 'orpheus:', top = true } = {}) {
  const errors = [];
  const sandbox = { __order: [], location: { protocol }, console: { log() {}, error: (...a) => errors.push(a.map(String).join(' ')) } };
  sandbox.window = sandbox;
  sandbox.top = top ? sandbox : {};
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: 'injection.js' });
  sandbox.__errors = errors;
  sandbox.__eval = (expr) => vm.runInContext(expr, ctx);
  return sandbox;
}

test('produces a script that parses', () => {
  assert.doesNotThrow(() => new vm.Script(buildInjection(baseOpts())));
});

test('top orpheus frame gets consts, preludes, framework and startup scripts in order', () => {
  const w = runPage(buildInjection(baseOpts()));
  assert.deepEqual(w.__order, [
    'polyfills', 'native', 'hijack', 'devtools', 'channel', 'extra', 'framework', 'startup:good', 'startup:after',
  ]);
  assert.equal(w.__eval('BETTERNCM_API_KEY'), 'k'.repeat(64));
  assert.equal(w.__eval('BETTERNCM_API_PORT'), 4567);
  assert.equal(w.__eval('BETTERNCM_API_PATH'), 'http://127.0.0.1:4567/api');
  assert.equal(w.__eval('BETTERNCM_FILES_PATH'), 'http://127.0.0.1:4567/local');
  assert.equal(w.__eval('__BNCM_TARGET__'), 'T1');
  assert.equal(w.__eval('__BNCM_SAFE__'), false);
  assert.equal(w.__eval('__BNCM_CFG__')['mac.channelShim'], 'true');
  assert.equal(w.betterncm_native.target, 'T1');
  assert.equal(w.betterncm.path, 'http://127.0.0.1:4567/api');
  assert.equal(w.__hijacks.length, 1);
  // startup scripts run at global scope, like separate scripts in v2
  assert.equal(w.goodGlobal, 1);
  // the broken and throwing scripts are reported but do not stop the others
  assert.ok(w.__errors.some((e) => e.includes('startup script of broken')));
  assert.ok(w.__errors.some((e) => e.includes('startup script of throws')));
});

test('sub frames get the shim but not the framework', () => {
  const w = runPage(buildInjection(baseOpts()), { top: false });
  assert.deepEqual(w.__order, ['polyfills', 'native', 'hijack', 'devtools']);
});

test('non-orpheus documents only get the consts, without the secrets', () => {
  const w = runPage(buildInjection(baseOpts()), { protocol: 'https:' });
  assert.deepEqual(w.__order, []);
  assert.equal(w.__eval('BETTERNCM_API_PORT'), 0);
  assert.equal(w.__eval('BETTERNCM_API_KEY'), '');
  assert.equal(w.__eval('BETTERNCM_API_PATH'), '');
});

test('with a DOM, startup scripts run as classic scripts: const/let/class become globals', () => {
  const src = buildInjection(baseOpts({
    startupScripts: [
      { slug: 'decl', code: `const SharedHook = { n: 1 }; let SharedLet = 2; class SharedClass {}` },
      { slug: 'broken', code: `this is not javascript (` },
      { slug: 'use', code: `window.__seen = SharedHook.n + SharedLet + typeof SharedClass;` },
    ],
  }));
  const errors = [];
  const listeners = new Set();
  const sandbox = { __order: [], location: { protocol: 'orpheus:' }, console: { log() {}, error: (...a) => errors.push(a.map(String).join(' ')) } };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  sandbox.addEventListener = (t, f) => { if (t === 'error') listeners.add(f); };
  sandbox.removeEventListener = (t, f) => { if (t === 'error') listeners.delete(f); };
  const ctx = vm.createContext(sandbox);
  // appendChild of a script element runs its text as a separate classic script, errors go to 'error' listeners
  sandbox.document = {
    createElement: () => ({ text: '', remove() {} }),
    documentElement: {
      appendChild: (s) => {
        try { vm.runInContext(s.text, ctx); } catch (e) { for (const f of listeners) f({ error: e, message: String(e) }); }
      },
    },
  };
  vm.runInContext(src, ctx);
  assert.equal(sandbox.__seen, '3function');
  assert.ok(errors.some((e) => e.includes('startup script of broken')));
  assert.equal(listeners.size, 0);
});

test('safe mode drops hijacks and startup scripts', () => {
  const w = runPage(buildInjection(baseOpts({ safe: true })));
  assert.deepEqual(w.__order, ['polyfills', 'native', 'devtools', 'channel', 'extra', 'framework']);
  assert.equal(w.__eval('__BNCM_SAFE__'), true);
  assert.equal(w.__eval('JSON.stringify(__BNCM_HIJACKS__)'), '[]');
});

test('channel shim is left out unless enabled', () => {
  const w = runPage(buildInjection(baseOpts({ cfg: { 'mac.channelShim': 'false' } })));
  assert.ok(!w.__order.includes('channel'));
});

test('sourceURLs: framework and each startup script keep their own', () => {
  const src = buildInjection(baseOpts());
  assert.match(src, /sourceURL=betterncm:\/\/betterncm\/framework\.js/);
  assert.match(src, /sourceURL=file:\/\/good\/startup_script\.js/);
  assert.match(src, /\/\/# sourceURL=betterncm:\/\/betterncm\/injection\.js\n$/);
});

test('a prelude file with a syntax error is skipped, not fatal', () => {
  const bad = path.join(root, 'src/prelude/devtools-key.js');
  const orig = fs.readFileSync(bad, 'utf8');
  fs.writeFileSync(bad, 'function (');
  try {
    const w = runPage(buildInjection(baseOpts()));
    assert.ok(!w.__order.includes('devtools'));
    assert.ok(w.__order.includes('framework'));
    assert.ok(w.__errors.some((e) => e.includes('devtools-key.js skipped')));
  } finally {
    fs.writeFileSync(bad, orig);
  }
});

test('strings with quotes and line separators are embedded safely', () => {
  const tricky = `';alert(1);//  </script>`;
  const src = buildInjection(baseOpts({ targetId: tricky, startupScripts: [] }));
  const w = runPage(src);
  assert.equal(w.__eval('__BNCM_TARGET__'), tricky);
});

test('missing framework is reported in the page', () => {
  const fw = path.join(root, 'dist/framework.js');
  fs.renameSync(fw, fw + '.bak');
  try {
    const w = runPage(buildInjection(baseOpts()));
    assert.ok(!w.__order.includes('framework'));
    assert.ok(w.__errors.some((e) => e.includes('framework.js is missing')));
  } finally {
    fs.renameSync(fw + '.bak', fw);
  }
});

test('look-and-feel preludes only run when their config key is true', () => {
  const optional = {
    'compat-rnp-layout.js': `window.__order.push('layout');`,
    'compat-rnp-cover.js': `window.__order.push('cover');`,
    'compat-rnp-top-controls.js': `window.__order.push('top');`,
    'compat-rnp-menu-style.js': `window.__order.push('menustyle');`,
    'compat-rnp-panels.js': `window.__order.push('panels');`,
    'compat-rnp-lyric-switch.js': `window.__order.push('lyricswitch');`,
    'stop-mini-vinyl.js': `window.__order.push('vinyl');`,
    'compat-rnp-lyric-size.js': `window.__order.push('lyricsize');`,
    'lyrics-bridge.js': `window.__order.push('lyricsbridge');`,
    'hide-plugin-manager.js': `window.__order.push('hidepm');`,
  };
  for (const [f, code] of Object.entries(optional)) fs.writeFileSync(path.join(root, 'src/prelude', f), code);
  try {
    const order = (cfg) => runPage(buildInjection(baseOpts({ cfg: { ...baseOpts().cfg, ...cfg } }))).__order;
    const off = order({});
    assert.ok(off.includes('extra'));
    for (const n of ['layout', 'cover', 'top', 'menustyle', 'panels', 'lyricswitch', 'vinyl', 'lyricsize']) assert.ok(!off.includes(n), `${n} ran without its key`);
    assert.deepEqual(order({ 'mac.rnpAppleStyle': 'true' }).filter((n) => ['layout', 'cover', 'top', 'menustyle', 'panels', 'lyricswitch', 'vinyl'].includes(n)), ['cover', 'layout', 'lyricswitch', 'menustyle', 'panels', 'top']);
    assert.deepEqual(order({ 'mac.stopMiniVinyl': 'true' }).filter((n) => ['layout', 'cover', 'vinyl'].includes(n)), ['vinyl']);
    assert.ok(order({ 'mac.rnpAutoLyricSize': 'true' }).includes('lyricsize'));
    // "!key": runs unless the key is 'true'.
    assert.ok(off.includes('hidepm'), 'hide-plugin-manager runs by default');
    assert.ok(!order({ 'mac.pluginManager': 'true' }).includes('hidepm'));
    // The lyrics window replaces RefinedNowPlayingNext: its bridge comes in, every compat-rnp-* goes.
    assert.ok(!off.includes('lyricsbridge'));
    const lw = order({ 'mac.lyricsWindow': 'true', 'mac.rnpAppleStyle': 'true', 'mac.rnpAutoLyricSize': 'true' });
    assert.ok(lw.includes('lyricsbridge'));
    for (const n of ['layout', 'cover', 'top', 'menustyle', 'panels', 'lyricswitch', 'lyricsize']) assert.ok(!lw.includes(n), `${n} ran with the lyrics window on`);
  } finally {
    for (const f of Object.keys(optional)) fs.rmSync(path.join(root, 'src/prelude', f), { force: true });
  }
});
