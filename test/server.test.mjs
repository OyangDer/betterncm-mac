// API server: auth, CORS, App.cpp route formats, native bridge, SSE callbacks, static mounts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP_ROOT = process.env.BNCM_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const DP = fs.realpathSync(fs.mkdtempSync(path.join(TMP_ROOT, 'bncm-server-')));
process.env.BETTERNCM_PROFILE = DP;

const { startServer } = await import('../src/server.mjs');

const KEY = 'k'.repeat(64);
const calls = { reload: 0, restart: 0, reports: [] };
let srv;
let base;

const H = { BETTERNCM_API_KEY: KEY };

function api(rel, opt = {}) {
  return fetch(base + '/api' + rel, { ...opt, headers: { ...H, ...(opt.headers ?? {}) } });
}

function native(name, args, target = 'T1', context = null) {
  const headers = { 'Content-Type': 'application/json', 'X-BNCM-Target': target };
  if (context) headers['X-BNCM-Context'] = context;
  return api('/native/' + name, {
    method: 'POST',
    headers,
    body: JSON.stringify(args),
  }).then((r) => r.json());
}

function rawGet(p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Minimal SSE reader over fetch.
async function openEvents(target, context = null) {
  const ctrl = new AbortController();
  const ctx = context ? `&ctx=${context}` : '';
  const res = await fetch(`${base}/api/events?key=${KEY}&target=${target}${ctx}`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const messages = [];
  const waiters = [];
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (data) {
            messages.push(JSON.parse(data));
            waiters.splice(0).forEach((w) => w());
          }
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    messages,
    async waitFor(pred, ms = 5000) {
      const end = Date.now() + ms;
      for (;;) {
        const m = messages.find(pred);
        if (m) return m;
        if (Date.now() > end) throw new Error('timed out; got ' + JSON.stringify(messages));
        await new Promise((r) => {
          waiters.push(r);
          setTimeout(r, 100);
        });
      }
    },
    close: () => ctrl.abort(),
  };
}

before(async () => {
  for (const d of ['plugins', 'plugins_runtime', 'plugins_dev', 'run', 'log']) fs.mkdirSync(path.join(DP, d), { recursive: true });
  srv = await startServer({
    apiKey: KEY,
    hooks: {
      onReloadPlugin: async () => {
        calls.reload++;
      },
      onRestart: async () => {
        calls.restart++;
      },
      onHijackReport: (target, ids) => calls.reports.push([target, ids]),
    },
  });
  base = `http://127.0.0.1:${srv.port}`;
});

after(async () => {
  await srv.close();
  fs.rmSync(DP, { recursive: true, force: true });
});

test('auth: /api needs the key; get_win_position does not', async () => {
  assert.equal((await fetch(base + '/api/app/version')).status, 401);
  assert.equal((await fetch(base + '/api/app/version', { headers: { BETTERNCM_API_KEY: 'wrong' } })).status, 401);
  const r = await api('/app/version');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '1.3.4');
  const pos = await fetch(base + '/api/app/get_win_position');
  assert.deepEqual(await pos.json(), { x: 0, y: 0 });
  assert.equal((await fetch(`${base}/api/events?key=nope&target=x`)).status, 401);
});

test('CORS: OPTIONS is 204 and only orpheus://orpheus is echoed', async () => {
  const pre = await fetch(base + '/api/fs/exists', { method: 'OPTIONS', headers: { Origin: 'orpheus://orpheus' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'orpheus://orpheus');
  assert.match(pre.headers.get('access-control-allow-headers'), /BETTERNCM_API_KEY/);
  assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
  const evil = await api('/app/version', { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal(evil.headers.get('cache-control'), 'no-store');
});

test('foreign Host headers are refused (DNS rebinding)', async () => {
  const r = await rawGet('/local/x', { Host: 'evil.example:80' });
  assert.equal(r.status, 403);
  const ok = await rawGet('/api/app/get_win_position', { Host: `localhost:${srv.port}` });
  assert.equal(ok.status, 200);
});

test('fs routes: write_file (multipart), exists, read_file_text, read_dir, rename, mkdir, remove', async () => {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff])]), 'x.plugin');
  const w = await api('/fs/write_file?path=' + encodeURIComponent('./plugins/x.plugin'), { method: 'POST', body: fd });
  assert.equal(w.status, 200);
  assert.deepEqual([...fs.readFileSync(path.join(DP, 'plugins', 'x.plugin'))], [0x50, 0x4b, 0x03, 0x04, 0xff]);

  assert.equal(await (await api('/fs/exists?path=./plugins/x.plugin')).json(), true);
  assert.equal(await (await api('/fs/exists?path=./plugins/y.plugin')).json(), false);

  assert.equal((await api('/fs/write_file_text?path=' + encodeURIComponent('/notes/a.txt'), { method: 'POST', body: '你好' })).status, 200);
  assert.equal(await (await api('/fs/read_file_text?path=/notes/a.txt')).text(), '你好');
  assert.equal(await (await api('/fs/read_file_text?path=/notes/missing.txt')).text(), '');

  const dir = await (await api('/fs/read_dir?path=' + encodeURIComponent('./notes'))).json();
  assert.deepEqual(dir, [DP + '/./notes/a.txt']);

  const rn = await api('/fs/rename?path=./notes/a.txt&dest=./notes/b.txt');
  assert.equal(await rn.text(), 'ok');
  assert.equal((await api('/fs/mkdir?path=./made/deep')).status, 200);
  assert.ok(fs.statSync(path.join(DP, 'made', 'deep')).isDirectory());
  assert.equal((await api('/fs/remove?path=./notes')).status, 200);
  assert.equal(fs.existsSync(path.join(DP, 'notes')), false);

  const bin = await api('/fs/read_file?path=./plugins/x.plugin');
  assert.equal(bin.headers.get('content-type'), 'application/octet-stream');
  assert.equal((await bin.arrayBuffer()).byteLength, 5);

  assert.equal((await api('/fs/read_dir?path=./nope')).status, 500);
  const outside = fs.mkdtempSync(path.join(TMP_ROOT, 'bncm-srv-out-'));
  try {
    assert.equal((await api('/fs/remove?path=' + encodeURIComponent(outside))).status, 403);
    assert.ok(fs.existsSync(outside));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('config routes round-trip through config.json', async () => {
  assert.equal(await (await api('/app/read_config?key=cc.test&default=dflt')).text(), 'dflt');
  assert.equal((await api('/app/write_config?key=cc.test&value=' + encodeURIComponent('a b&c'))).status, 200);
  assert.equal(await (await api('/app/read_config?key=cc.test&default=dflt')).text(), 'a b&c');
  assert.equal(JSON.parse(fs.readFileSync(path.join(DP, 'config.json'), 'utf8'))['cc.test'], 'a b&c');
  // the exec/fs policy keys cannot be changed from the page
  assert.equal((await api('/app/write_config?key=mac.allowExec&value=true')).status, 403);
  assert.equal(JSON.parse(fs.readFileSync(path.join(DP, 'config.json'), 'utf8'))['mac.allowExec'], undefined);
  const r = await native('fs.writeFileText', ['./config.json', '{"mac.allowExec":"true"}']);
  assert.equal(r.ok, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(DP, 'config.json'), 'utf8'))['mac.allowExec'], undefined);
});

test('app routes: datapath, ncmpath, reload_plugin awaits the hook, stubs', async () => {
  assert.equal(await (await api('/app/datapath')).text(), DP);
  assert.equal(await (await api('/app/ncmpath')).text(), '/Applications/NeteaseMusic.app/Contents/MacOS');
  const before = calls.reload;
  assert.equal((await api('/app/reload_plugin')).status, 200);
  assert.equal(calls.reload, before + 1);
  assert.equal((await api('/app/show_console?false')).status, 200);
  assert.equal((await api('/app/set_rounded_corner?enable=true')).status, 200);
  assert.equal((await api('/app/bg_screenshot')).status, 501);
  assert.ok(['true', 'false'].includes(await (await api('/app/is_light_theme')).text()));
  assert.equal((await api('/app/exec_ele', { method: 'POST', body: 'cmd' })).status, 403);
  assert.equal((await api('/app/exec', { method: 'POST', body: 'rm -rf /' })).status, 403);
  assert.equal((await api('/app/exec', { method: 'POST', body: 'cmd /c @echo off' })).status, 403);
  assert.equal((await api('/app/nope')).status, 404);
});

test('native bridge: values, v2 argument errors, unknown APIs', async () => {
  fs.mkdirSync(path.join(DP, 'plugins_runtime', 'A'), { recursive: true });
  assert.deepEqual(await native('fs.readDir', ['./plugins_runtime']), { ok: true, value: [DP + '/./plugins_runtime/A'] });
  assert.deepEqual(await native('fs.exists', ['./plugins_dev']), { ok: true, value: true });
  assert.deepEqual(await native('fs.readFileText', ['./none.txt']), { ok: true, value: '' });
  assert.deepEqual(await native('fs.writeFileText', ['/__TEST_SUCCEEDED__.txt', 'yes']), { ok: true, value: true });
  assert.equal(fs.readFileSync(path.join(DP, '__TEST_SUCCEEDED__.txt'), 'utf8'), 'yes');
  assert.deepEqual(await native('app.version', []), { ok: true, value: '1.3.4' });
  assert.deepEqual(await native('app.datapath', []), { ok: true, value: DP });
  assert.deepEqual(await native('test.add', [1, 2.5]), { ok: true, value: 3.5 });
  assert.deepEqual(await native('native_plugin.getRegisteredAPIs', []), { ok: true, value: [] });
  assert.deepEqual(await native('app.auto_update', ['https://example.invalid/']), { ok: true, value: null });

  const props = await native('fs.getProperties', ['/__TEST_SUCCEEDED__.txt']);
  assert.equal(props.ok, true);
  assert.equal(props.value.path, DP);
  assert.ok(props.value.lastModified > 11644473600000);

  assert.deepEqual(await native('fs.rename', ['./x']), {
    ok: false, error: 'Too few arguments. Expected 2 arguments, received 1 arguments.',
  });
  assert.deepEqual(await native('fs.exists', ['a', 'b']), {
    ok: false, error: 'Too many arguments. Expected 1 arguments, received 2 arguments.',
  });
  assert.match((await native('fs.exists', [1])).error, /Invalid argument 0/);
  assert.match((await native('nope.nothing', [])).error, /Unknown native API/);
  assert.match((await native('native_plugin.call', ['x', []])).error, /Invalid api id/);
  assert.match((await native('fs.readDir', ['C:\\Windows'])).error, /Windows path not supported/);
  assert.equal((await fetch(base + '/api/native/fs.exists', { method: 'POST', body: '["x"]' })).status, 401);
});

test('native app.restart answers first, then fires the hook', async () => {
  const n = calls.restart;
  assert.deepEqual(await native('app.restart', []), { ok: true, value: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.restart, n + 1);
});

test('callbacks: watchDirectory and readFileTextAsync deliver over SSE', async () => {
  fs.mkdirSync(path.join(DP, 'plugins_dev', 'hot'), { recursive: true });
  fs.writeFileSync(path.join(DP, 'plugins_dev', 'hot', 'data.txt'), 'async text');

  // queued before the EventSource connects, then flushed
  assert.deepEqual(await native('fs.readFileTextAsync', ['./plugins_dev/hot/data.txt', { $cb: 'f-1' }], 'T2'), { ok: true, value: null });
  await new Promise((r) => setTimeout(r, 50));
  const es = await openEvents('T2');
  try {
    const m1 = await es.waitFor((m) => m.cb === 'f-1');
    assert.deepEqual(m1.args, ['async text']);

    assert.deepEqual(await native('fs.watchDirectory', ['./plugins_dev/hot', { $cb: 'f-2' }], 'T2'), { ok: true, value: null });
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(DP, 'plugins_dev', 'hot', 'main.js'), '1');
    const m2 = await es.waitFor((m) => m.cb === 'f-2' && m.args[1] === 'main.js');
    assert.equal(m2.args[0], DP + '/./plugins_dev/hot');

    srv.broadcast('T2', { cb: 'manual', args: [1] });
    srv.broadcast(null, { cb: 'all', args: [] });
    await es.waitFor((m) => m.cb === 'manual');
    await es.waitFor((m) => m.cb === 'all');
  } finally {
    es.close();
  }
  assert.match((await native('fs.watchDirectory', ['./plugins_dev/hot', 'notafunction'], 'T2')).error, /Invalid argument 1/);
});

test('watchers belong to their document: a reload or a dropped stream does not lose them', async () => {
  const dir = path.join(DP, 'plugins_dev', 'reload');
  fs.mkdirSync(dir, { recursive: true });
  const oldPage = await openEvents('T3', 'old');
  // the reloaded page registers its watcher before the old page's EventSource has closed
  assert.deepEqual(await native('fs.watchDirectory', ['./plugins_dev/reload', { $cb: 'new-1' }], 'T3', 'new'), { ok: true, value: null });
  oldPage.close();
  await new Promise((r) => setTimeout(r, 100));
  const newPage = await openEvents('T3', 'new');
  try {
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(dir, 'main.js'), '2');
    const m = await newPage.waitFor((x) => x.cb === 'new-1' && x.args[1] === 'main.js');
    assert.equal(m.args[0], DP + '/./plugins_dev/reload');
  } finally {
    newPage.close();
  }
  // CEF drops quiet streams and the EventSource reconnects: the watchers survive that
  await new Promise((r) => setTimeout(r, 100));
  const again = await openEvents('T3', 'new');
  try {
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(dir, 'other.js'), '3');
    await again.waitFor((x) => x.cb === 'new-1' && x.args[1] === 'other.js');
  } finally {
    again.close();
  }
});

test('/local serves the data dir but never config.json, run/, log/ or ..', async () => {
  fs.mkdirSync(path.join(DP, 'plugins_runtime', 'P'), { recursive: true });
  fs.writeFileSync(path.join(DP, 'plugins_runtime', 'P', 'a b.css'), 'body{}');
  fs.writeFileSync(path.join(DP, 'run', 'state.json'), '{"apiKey":"secret"}');
  const ok = await fetch(base + '/local/plugins_runtime/P/a%20b.css');
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /^text\/css/);
  assert.equal(await ok.text(), 'body{}');
  assert.equal((await fetch(base + '/local/config.json')).status, 403);
  assert.equal((await fetch(base + '/local/CONFIG.JSON')).status, 403);
  assert.equal((await fetch(base + '/local/run/state.json')).status, 403);
  assert.equal((await fetch(base + '/local/Run/state.json')).status, 403);
  assert.equal((await fetch(base + '/local/log/injector.log')).status, 403);
  // dot segments are either normalized out of /local (404) or refused (403); never served
  for (const p of ['/local/plugins/../config.json', '/local/%2e%2e/%2e%2e/etc/hosts', '/local/plugins%2f..%2f..%2fetc/hosts', '/local/run%2fstate.json']) {
    const r = await rawGet(p);
    assert.ok([403, 404].includes(r.status), p + ' -> ' + r.status);
    assert.doesNotMatch(r.body, /secret|localhost/);
  }
  assert.equal((await fetch(base + '/local/missing.txt')).status, 404);
});

test('mount_file serves with Range; mount_dir serves a tree with a traversal guard', async () => {
  const media = path.join(DP, 'media');
  fs.mkdirSync(path.join(media, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(media, 'clip.mp4'), Buffer.from('0123456789'));
  fs.writeFileSync(path.join(media, 'sub', 'x.json'), '{"a":1}');

  const url = await (await api('/fs/mount_file?path=./media/clip.mp4')).text();
  assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${srv.port}/mounted_file/[A-Za-z0-9]{48}\\.mp4$`));
  const full = await fetch(url);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(await full.text(), '0123456789');
  const part = await fetch(url, { headers: { Range: 'bytes=2-4' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 2-4/10');
  assert.equal(await part.text(), '234');
  const tail = await fetch(url, { headers: { Range: 'bytes=-3' } });
  assert.equal(await tail.text(), '789');
  assert.equal((await fetch(url, { headers: { Range: 'bytes=20-' } })).status, 416);

  const dirUrl = await (await api('/fs/mount_dir?path=./media')).text();
  assert.match(dirUrl, /\/mounted_dir\/[A-Za-z0-9]{48}$/);
  const j = await fetch(dirUrl + '/sub/x.json');
  assert.equal(j.status, 200);
  assert.deepEqual(await j.json(), { a: 1 });
  const rel = new URL(dirUrl).pathname;
  fs.writeFileSync(path.join(DP, 'config.json'), '{"secret":"1"}');
  for (const p of [rel + '/../../config.json', rel + '/%2e%2e/%2e%2e/config.json', rel + '/sub%2f..%2f..%2fconfig.json']) {
    const r = await rawGet(p);
    assert.ok([403, 404].includes(r.status), p + ' -> ' + r.status);
    assert.doesNotMatch(r.body, /secret/);
  }
  assert.equal((await fetch(base + '/mounted_file/doesnotexist.mp4')).status, 404);
});

test('hijack reports and emulated CSP ids show up in get_succeeded_hijacks', async () => {
  fs.mkdirSync(path.join(DP, 'plugins_dev', 'csp'), { recursive: true });
  fs.writeFileSync(path.join(DP, 'plugins_dev', 'csp', 'manifest.json'), JSON.stringify({
    manifest_version: 1,
    name: 'csp',
    hijacks: {
      '>= 1.0.0': {
        'orpheus://orpheus/pub/app.html': {
          type: 'replace', id: 'csp-worker',
          from: '<meta http-equiv="Content-Security-Policy" content="script-src ', to: 'x',
        },
      },
    },
  }));
  const r = await api('/internal/hijack_report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BNCM-Target': 'T9' },
    body: JSON.stringify({ ids: ['RefinedNowPlayingNext::redux-dispatch-hook', 42] }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.reports.at(-1), ['T9', ['RefinedNowPlayingNext::redux-dispatch-hook']]);
  const ids = await (await api('/app/get_succeeded_hijacks')).json();
  assert.ok(ids.includes('RefinedNowPlayingNext::redux-dispatch-hook'));
  if (fs.existsSync('/Applications/NeteaseMusic.app/Contents/Info.plist')) assert.ok(ids.includes('csp::csp-worker'));
});
