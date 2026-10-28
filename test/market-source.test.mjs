// src/prelude/market-source.js: source seeding and the GitHub -> jsDelivr fallback, in a vm
// context with a fake fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = fs.readFileSync(path.join(ROOT, 'src/prelude/market-source.js'), 'utf8');
const GH = 'https://raw.githubusercontent.com/BetterNCM/BetterNCM-Packed-Plugins/master/';
const JSD = 'https://cdn.jsdelivr.net/gh/BetterNCM/BetterNCM-Packed-Plugins@master/';

// `respond(url)` returns {status} or throws; returns the page window and the URLs fetched.
function load(respond, storage = {}) {
  const calls = [];
  const win = {
    localStorage: {
      getItem: (k) => (Object.hasOwn(storage, k) ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
    },
    fetch: async (url) => {
      calls.push(url);
      const r = await respond(url);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, url };
    },
    console: { warn() {}, log() {}, error() {} },
    setTimeout, clearTimeout, AbortController, DOMException, URL,
  };
  win.window = win;
  vm.runInContext(CODE, vm.createContext(win));
  return { win, calls, storage };
}

test('seeds the GitHub source once and keeps a later choice', () => {
  const { storage } = load(() => ({ status: 200 }));
  assert.equal(storage['plugin-market-gen2-source'], 'Github (UserContent)');
  const kept = load(() => ({ status: 200 }), { 'plugin-market-gen2-source': 'Default' }).storage;
  assert.equal(kept['plugin-market-gen2-source'], 'Default');
});

test('other URLs pass through untouched', async () => {
  const { win, calls } = load(() => ({ status: 200 }));
  await win.fetch('http://127.0.0.1:1/api/x');
  assert.deepEqual(calls, ['http://127.0.0.1:1/api/x']);
});

test('the gitcode mirror and GitHub Raw are served from GitHub UserContent', async () => {
  const { win, calls } = load(() => ({ status: 200 }));
  await win.fetch('https://raw.gitcode.com/intensity/bncm-plugin-packed/raw/master/plugins.json?1');
  await win.fetch('https://github.com/BetterNCM/BetterNCM-Packed-Plugins/raw/master/plugins/A.plugin');
  assert.deepEqual(calls, [`${GH}plugins.json?1`, `${GH}plugins/A.plugin`]);
});

test('a GitHub error status falls back to jsDelivr for that request only', async () => {
  const { win, calls } = load((u) => ({ status: u.startsWith(GH) && u.includes('bad') ? 503 : 200 }));
  const r = await win.fetch(`${GH}bad.json`);
  assert.equal(r.url, `${JSD}bad.json`);
  await win.fetch(`${GH}good.json`);
  assert.deepEqual(calls, [`${GH}bad.json`, `${JSD}bad.json`, `${GH}good.json`]);
});

test('a GitHub network failure switches the session to jsDelivr', async () => {
  const { win, calls } = load((u) => {
    if (u.startsWith(GH)) throw new TypeError('Failed to fetch');
    return { status: 200 };
  });
  await win.fetch(`${GH}plugins.json`);
  await win.fetch(`${GH}plugins/B.plugin`);
  assert.deepEqual(calls, [`${GH}plugins.json`, `${JSD}plugins.json`, `${JSD}plugins/B.plugin`]);
});

test('a caller abort is not retried on jsDelivr', async () => {
  const { win, calls } = load(() => { throw new DOMException('aborted', 'AbortError'); });
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(win.fetch(`${GH}plugins.json`, { signal: ctl.signal }));
  assert.deepEqual(calls, [`${GH}plugins.json`]);
});

test('while GitHub is skipped, a jsDelivr error still gets one GitHub try', async () => {
  let githubBroken = true;
  const { win, calls } = load((u) => {
    if (u.startsWith(GH) && githubBroken) throw new TypeError('Failed to fetch');
    return { status: u.startsWith(JSD) && u.includes('big') ? 403 : 200 };
  });
  await win.fetch(`${GH}plugins.json`);
  githubBroken = false;
  const r = await win.fetch(`${GH}plugins/big.plugin`);
  assert.equal(r.url, `${GH}plugins/big.plugin`);
  assert.deepEqual(calls, [`${GH}plugins.json`, `${JSD}plugins.json`, `${JSD}plugins/big.plugin`, `${GH}plugins/big.plugin`]);
});

test('the online Default source (microblock.cc) is served from GitHub too', async () => {
  const { win, calls } = load(() => ({ status: 200 }));
  await win.fetch('https://bncm-plugin.microblock.cc/plugins.json');
  assert.deepEqual(calls, [`${GH}plugins.json`]);
});
