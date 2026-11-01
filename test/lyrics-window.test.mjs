// src/lyrics-window.mjs with a fake CDP connection and a fake host process: messages between NCM's
// page (the bridge) and the lyrics window, and the window's lifecycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const TMP_ROOT = process.env.BNCM_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const DP = fs.realpathSync(fs.mkdtempSync(path.join(TMP_ROOT, 'bncm-lyrics-')));
process.env.BETTERNCM_PROFILE = DP;

const { setQuiet } = await import('../src/log.mjs');
const { createLyricsRelay, BINDING } = await import('../src/lyrics-window.mjs');
const { MAC_VERSION } = await import('../src/config.mjs');
setQuiet(true);

const PATHS = { bin: path.join(DP, 'BNCMLyrics'), web: path.join(DP, 'web'), data: DP, cache: path.join(DP, 'cache') };
const tick = () => new Promise((r) => setImmediate(r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A CDP connection that records calls; Runtime.evaluate answers with `evalValue(expression, sid)`. */
function fakeCdp({ evalValue = () => true } = {}) {
  const calls = [];
  return {
    closed: false,
    calls,
    evals: () => calls.filter((c) => c.method === 'Runtime.evaluate'),
    commands: () => calls.filter((c) => c.method === 'Runtime.evaluate')
      .map((c) => /cmd\((\{.*\})\) :/.exec(c.params.expression)?.[1]).filter(Boolean).map((j) => JSON.parse(j)),
    async send(method, params, sid) {
      calls.push({ method, params, sid });
      if (method === 'Runtime.evaluate') {
        const v = evalValue(params.expression, sid);
        if (v instanceof Error) throw v;
        return { result: { value: v } };
      }
      return {};
    },
  };
}

/** A host child process: stdin lines are recorded, stdout lines are sent with `say`. */
function fakeHost() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.lines = [];
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stdin = {
    writable: true,
    write: (s) => { for (const l of s.split('\n').filter(Boolean)) child.lines.push(JSON.parse(l)); return true; },
    end: () => { child.stdin.writable = false; },
  };
  child.kill = () => { child.killed = true; };
  child.say = (obj) => child.stdout.emit('data', JSON.stringify(obj) + '\n');
  return child;
}

function setup({ evalValue, spawnFails = false, prewarmMs = null } = {}) {
  const cdp = fakeCdp({ evalValue });
  const hosts = [];
  const spawnHost = (bin, args) => {
    if (spawnFails) throw new Error('spawn failed');
    const h = fakeHost();
    h.bin = bin;
    h.args = args;
    hosts.push(h);
    return h;
  };
  const relay = createLyricsRelay({ getCdp: () => cdp, spawnHost, paths: PATHS, prewarmMs });
  const fromBridge = (msg, sid = 'S1') => relay.onBindingCalled({ name: BINDING, payload: JSON.stringify(msg) }, sid);
  return { cdp, hosts, relay, fromBridge };
}

test.after(() => fs.rmSync(DP, { recursive: true, force: true }));

test('attaching a session adds the binding and asks a running bridge for hello', async () => {
  const { cdp, relay } = setup();
  await relay.attachSession('S1');
  await tick();
  assert.deepEqual(cdp.calls[0], { method: 'Runtime.addBinding', params: { name: BINDING }, sid: 'S1' });
  assert.equal(cdp.calls[1].method, 'Runtime.evaluate');
  assert.equal(cdp.calls[1].sid, 'S1');
  assert.match(cdp.calls[1].params.expression, /cmd\(\{ c: 'hello' \}\)/);
});

test('after hello the host is started hidden, once, so the first open is instant', async () => {
  const { hosts, relay, fromBridge } = setup({ prewarmMs: 5 });
  fromBridge({ t: 'hello' });
  fromBridge({ t: 'hello' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(hosts.length, 1);
  assert.ok(!hosts[0].lines.some((l) => l.op === 'show'), 'not shown');
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 800, h: 600 } });
  await tick();
  assert.equal(hosts.length, 1, 'the open reuses it');
  relay.dispose();
});

test('dispose cancels a pending pre-warm', async () => {
  const { hosts, relay, fromBridge } = setup({ prewarmMs: 5 });
  fromBridge({ t: 'hello' });
  relay.dispose();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(hosts.length, 0);
});

test('a hello that cannot be evaluated does not fail the attach', async () => {
  const { relay } = setup({ evalValue: () => new Error('target is paused') });
  await relay.attachSession('S1');
  await tick();
});

test('open starts the host, shows the window over NCM and makes the bridge active', async () => {
  const { cdp, hosts, relay, fromBridge } = setup();
  fromBridge({ t: 'hello' });
  await tick();
  assert.equal(hosts.length, 0, 'no host before the first open');
  const frame = { x: 10, y: 76, w: 1470, h: 752 };
  fromBridge({ t: 'open', frame, fullscreen: false });
  await tick();
  assert.equal(hosts.length, 1);
  assert.deepEqual(hosts[0].args, ['--web', PATHS.web, '--data', PATHS.data, '--cache', PATHS.cache]);
  assert.deepEqual(hosts[0].lines, [
    { to: 'web', msg: { t: 'open', frame, fullscreen: false, version: MAC_VERSION } },
    { to: 'host', op: 'show', frame, fullscreen: false },
  ]);
  assert.deepEqual(cdp.commands(), [{ c: 'active', v: true }]);
  assert.equal(cdp.evals()[0].sid, 'S1');
  assert.equal(relay.isOpen, true);
  assert.equal(relay.hostRunning, true);

  // a second open reuses the host
  fromBridge({ t: 'open', frame, fullscreen: true });
  await tick();
  assert.equal(hosts.length, 1);
  assert.deepEqual(hosts[0].lines.at(-1), { to: 'host', op: 'show', frame, fullscreen: true });
});

test('bridge messages go to the page, page commands are evaluated in NCM', async () => {
  const { cdp, hosts, fromBridge } = setup();
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  const h = hosts[0];
  fromBridge({ t: 'progress', id: '1', pos: 3.5, wall: 1 });
  fromBridge({ t: 'hello' });
  assert.deepEqual(h.lines.slice(2), [
    { to: 'web', msg: { t: 'progress', id: '1', pos: 3.5, wall: 1 } },
    { to: 'web', msg: { t: 'hello' } },
  ]);
  h.say({ from: 'web', msg: { c: 'seek', sec: 12 } });
  await tick();
  const ev = cdp.evals().at(-1);
  assert.equal(ev.sid, 'S1');
  assert.equal(ev.params.awaitPromise, false, 'requests answer through the binding');
  assert.equal(ev.params.returnByValue, true);
  assert.match(ev.params.expression, /window\.__bncmLyricsBridge\.cmd\(\{"c":"seek","sec":12\}\)/);
  // page-to-host messages without `c` (h: ...) are the host's business
  const n = cdp.evals().length;
  h.say({ from: 'web', msg: { h: 'ready' } });
  await tick();
  assert.equal(cdp.evals().length, n);
});

test('a hello while the window is open re-activates a reloaded bridge', async () => {
  const { cdp, fromBridge } = setup();
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  fromBridge({ t: 'hello' }, 'S2');
  await tick();
  const ev = cdp.evals().at(-1);
  assert.equal(ev.sid, 'S2', 'the new session runs the bridge now');
  assert.deepEqual(cdp.commands().at(-1), { c: 'active', v: true });
});

test('a page request gets an error reply when NCM\'s page has no bridge', async () => {
  const { hosts, fromBridge } = setup({ evalValue: (expr) => (/"c":"fetch"/.test(expr) ? 'no-bridge' : true) });
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  hosts[0].say({ from: 'web', msg: { c: 'fetch', rid: 7, url: 'https://music.163.com/api/x' } });
  await tick();
  await tick();
  assert.deepEqual(hosts[0].lines.at(-1), { to: 'web', msg: { t: 'reply', rid: 7, ok: false, error: 'NCM page not ready' } });

  // and when the session is gone
  const s2 = setup();
  s2.fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  s2.relay.detachSession('S1');
  s2.hosts[0].say({ from: 'web', msg: { c: 'rnpSettings', rid: 8 } });
  await tick();
  await tick();
  assert.deepEqual(s2.hosts[0].lines.at(-1), { to: 'web', msg: { t: 'reply', rid: 8, ok: false, error: 'NCM page not ready' } });
});

test('closing raises NCM at the window\'s frame, then hides the window', async () => {
  const { cdp, hosts, relay, fromBridge } = setup();
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  const frame = { x: 5, y: 80, w: 1200, h: 800 };
  const cocoa = { x: 5, y: 76, w: 1200, h: 800 };
  hosts[0].say({ from: 'host', op: 'closing', frame, cocoa });
  await tick();
  await tick();
  assert.deepEqual(cdp.commands().slice(1), [{ c: 'showNcm', frame, cocoa }, { c: 'active', v: false }]);
  assert.equal(relay.isOpen, false);
  assert.ok(!hosts[0].lines.some((l) => l.op === 'hide'), 'not hidden before NCM is up');
  await wait(200);
  assert.deepEqual(hosts[0].lines.at(-1), { to: 'host', op: 'hide' });
});

test('opening again while closing keeps the window', async () => {
  const { cdp, hosts, relay, fromBridge } = setup();
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  hosts[0].say({ from: 'host', op: 'closing', frame: { x: 0, y: 0, w: 1, h: 1 }, cocoa: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  await tick();
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  await wait(200);
  assert.ok(!hosts[0].lines.some((l) => l.op === 'hide'), 'not hidden');
  assert.equal(relay.isOpen, true);
  assert.deepEqual(cdp.commands().at(-1), { c: 'active', v: true });
});

test('minimizing minimizes NCM and makes the bridge inactive', async () => {
  const { cdp, hosts, relay, fromBridge } = setup();
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  hosts[0].say({ from: 'host', op: 'minimizing' });
  await tick();
  assert.deepEqual(cdp.commands().slice(1), [{ c: 'minimizeNcm' }, { c: 'active', v: false }]);
  assert.equal(relay.isOpen, false);
});

test('the host exiting makes the bridge inactive, and the next open starts a new host', async () => {
  const { cdp, hosts, relay, fromBridge } = setup();
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  const pending = assert.rejects(relay.evalInWindow('1 + 1'), /exited/);
  hosts[0].emit('exit', 1, null);
  await tick();
  await pending;
  assert.deepEqual(cdp.commands().at(-1), { c: 'active', v: false });
  assert.equal(relay.isOpen, false);
  assert.equal(relay.hostRunning, false);
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  assert.equal(hosts.length, 2);
  assert.equal(relay.isOpen, true);
});

test('when the host cannot start, NCM opens its own page', async () => {
  const { cdp, relay, fromBridge } = setup({ spawnFails: true });
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  assert.deepEqual(cdp.commands(), [{ c: 'fallback' }]);
  assert.equal(relay.isOpen, false);

  // the same without a binary on disk
  const cdp2 = fakeCdp();
  const relay2 = createLyricsRelay({ getCdp: () => cdp2, paths: { ...PATHS, bin: path.join(DP, 'missing') } });
  relay2.onBindingCalled({ name: BINDING, payload: JSON.stringify({ t: 'open', frame: {} }) }, 'S1');
  await tick();
  assert.deepEqual(cdp2.commands(), [{ c: 'fallback' }]);
});

test('a spawn that fails asynchronously counts as an exit', async () => {
  const { hosts, relay, fromBridge } = setup();
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  hosts[0].pid = undefined;
  hosts[0].emit('error', new Error('ENOENT'));
  await tick();
  assert.equal(relay.hostRunning, false);
  assert.equal(relay.isOpen, false);
});

test('development eval and snapshot calls are answered by the host', async () => {
  const { hosts, relay, fromBridge } = setup();
  await assert.rejects(relay.evalInWindow('1'), /not running/);
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  const h = hosts[0];
  const ev = relay.evalInWindow('document.title');
  const snap = relay.snapshotWindow('/tmp/x.png');
  const [e, s] = h.lines.slice(-2);
  assert.equal(e.op, 'eval');
  assert.equal(e.js, 'document.title');
  assert.equal(s.op, 'snapshot');
  assert.equal(s.path, '/tmp/x.png');
  h.say({ from: 'host', op: 'evalResult', id: s.id, error: 'no window' });
  h.say({ from: 'host', op: 'evalResult', id: e.id, value: 'Lyrics' });
  assert.equal(await ev, 'Lyrics');
  await assert.rejects(snap, /no window/);
});

test('host output split across chunks and bad lines are handled', async () => {
  const { cdp, hosts, fromBridge } = setup();
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  const line = JSON.stringify({ from: 'web', msg: { c: 'toggle' } });
  hosts[0].stdout.emit('data', 'not json\n' + line.slice(0, 10));
  hosts[0].stdout.emit('data', line.slice(10) + '\n');
  await tick();
  assert.deepEqual(cdp.commands().at(-1), { c: 'toggle' });
});

test('other bindings and bad payloads are ignored', async () => {
  const { cdp, hosts, relay } = setup();
  relay.onBindingCalled({ name: 'somethingElse', payload: '{"t":"open"}' }, 'S1');
  relay.onBindingCalled({ name: BINDING, payload: 'nope' }, 'S1');
  relay.onBindingCalled({ name: BINDING, payload: '3' }, 'S1');
  await tick();
  assert.equal(hosts.length, 0);
  assert.equal(cdp.calls.length, 0);
});

test('dispose ends the host', async () => {
  const { hosts, relay, fromBridge } = setup();
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  relay.dispose();
  assert.equal(hosts[0].stdin.writable, false);
  assert.equal(relay.hostRunning, false);
  assert.equal(relay.isOpen, false);
});
