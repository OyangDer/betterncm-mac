// The lyrics window's development routes (server.mjs, LYRICS-WINDOW.md Development): only with
// mac.lyricsTest on, and snapshots only into the temp directories.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_ROOT = process.env.BNCM_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const DP = fs.realpathSync(fs.mkdtempSync(path.join(TMP_ROOT, 'bncm-lyrics-dev-')));
process.env.BETTERNCM_PROFILE = DP;

const { startServer } = await import('../src/server.mjs');
const { writeConfigKey } = await import('../src/config.mjs');
const { setQuiet } = await import('../src/log.mjs');
setQuiet(true);

const KEY = 'k'.repeat(64);
const evals = [];
const snaps = [];
let srv;
let base;

const api = (rel, opt = {}) => fetch(base + '/api' + rel, { method: 'POST', ...opt, headers: { BETTERNCM_API_KEY: KEY } });
const snap = (p) => api('/internal/lyrics_snapshot?path=' + encodeURIComponent(p));

before(async () => {
  for (const d of ['plugins', 'plugins_runtime', 'plugins_dev', 'run', 'log']) fs.mkdirSync(path.join(DP, d), { recursive: true });
  srv = await startServer({
    apiKey: KEY,
    hooks: {
      onLyricsEval: async (js) => { evals.push(js); return 'v'; },
      onLyricsSnapshot: async (file) => { snaps.push(file); return file; },
    },
  });
  base = `http://127.0.0.1:${srv.port}`;
});

after(async () => {
  await srv.close();
  fs.rmSync(DP, { recursive: true, force: true });
});

test('without mac.lyricsTest the routes are not there', async () => {
  writeConfigKey('mac.lyricsTest', 'false');
  assert.equal((await api('/internal/lyrics_eval', { body: '1' })).status, 404);
  assert.equal((await snap(path.join(os.tmpdir(), 'a.png'))).status, 404);
  assert.deepEqual([evals, snaps], [[], []]);
});

test('with mac.lyricsTest, read per request: eval runs, snapshots go only under the temp directories', async () => {
  writeConfigKey('mac.lyricsTest', 'true');
  const r = await api('/internal/lyrics_eval', { body: '1 + 1' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { value: 'v' });
  assert.deepEqual(evals, ['1 + 1']);

  const tmp = fs.realpathSync(os.tmpdir());
  assert.equal((await snap(path.join(os.tmpdir(), 'a.png'))).status, 200);
  assert.equal((await snap('/tmp/b.png')).status, 200);
  assert.deepEqual(snaps, [path.join(tmp, 'a.png'), path.join(fs.realpathSync('/tmp'), 'b.png')], 'real paths');

  const outside = fs.mkdtempSync(path.join(os.homedir(), '.bncm-snap-'));
  try {
    for (const p of [path.join(outside, 'x.png'), path.join(tmp, '..', 'x.png'), path.join(tmp, 'x.txt'), 'x.png', path.join(tmp, 'missing-dir', 'x.png')]) {
      assert.equal((await snap(p)).status, 403, p);
    }
    // a link in the temp directory that leads out of it
    const link = fs.mkdtempSync(path.join(tmp, 'bncm-snap-'));
    try {
      fs.symlinkSync(outside, path.join(link, 'out'));
      fs.symlinkSync(path.join(outside, 'y.png'), path.join(link, 'y.png'));
      assert.equal((await snap(path.join(link, 'out', 'x.png'))).status, 403);
      assert.equal((await snap(path.join(link, 'y.png'))).status, 403);
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
  assert.equal(snaps.length, 2);

  writeConfigKey('mac.lyricsTest', 'false');
  assert.equal((await api('/internal/lyrics_eval', { body: '2' })).status, 404);
});
