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
const { createLyricsRelay, isBridgeContext, BINDING } = await import('../src/lyrics-window.mjs');
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

/** fromBridgeContext: the injector's check of the calling context; every call passes by default. */
function setup({ evalValue, spawnFails = false, prewarmMs = null, fromBridgeContext = () => true, quickExitMs } = {}) {
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
  const relay = createLyricsRelay({ getCdp: () => cdp, fromBridgeContext, spawnHost, paths: PATHS, prewarmMs, quickExitMs });
  const fromBridge = (msg, sid = 'S1', executionContextId = 1) =>
    relay.onBindingCalled({ name: BINDING, payload: JSON.stringify(msg), executionContextId }, sid);
  /** The bridge says hello and asks for the window; the calls so far are forgotten. */
  const openWindow = async (frame = { x: 0, y: 0, w: 1, h: 1 }, sid = 'S1') => {
    fromBridge({ t: 'hello' }, sid);
    fromBridge({ t: 'open', frame }, sid);
    await tick();
    cdp.calls.length = 0;
  };
  return { cdp, hosts, relay, fromBridge, openWindow };
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

test('turning the window off and on again pre-warms the host again', async () => {
  const { hosts, relay, fromBridge } = setup({ prewarmMs: 5 });
  fromBridge({ t: 'hello' });
  relay.dispose(); // mac.lyricsWindow 'false', with the pre-warm still pending
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  assert.equal(hosts.length, 0, 'no host while turned off');
  await relay.attachSession('S1'); // 'true' again: the pages get the binding back
  fromBridge({ t: 'hello' });
  await wait(30);
  assert.equal(hosts.length, 1);
  relay.dispose();
});

test('a hello that cannot be evaluated does not fail the attach', async () => {
  const { relay } = setup({ evalValue: () => new Error('target is paused') });
  await relay.attachSession('S1');
  await tick();
});

test('a hello while the window is closed resets a bridge left active', async () => {
  const { cdp, hosts, fromBridge } = setup();
  fromBridge({ t: 'hello' });
  await tick();
  assert.deepEqual(cdp.commands(), [{ c: 'active', v: false }]);
  assert.equal(cdp.evals()[0].sid, 'S1');
  assert.equal(hosts.length, 0);
});

test('open starts the host, shows the window over NCM and makes the bridge active', async () => {
  const { cdp, hosts, relay, fromBridge } = setup();
  fromBridge({ t: 'hello' });
  await tick();
  assert.equal(hosts.length, 0, 'no host before the first open');
  cdp.calls.length = 0;
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
  const { cdp, hosts, fromBridge, openWindow } = setup();
  await openWindow();
  const h = hosts[0];
  const n0 = h.lines.length;
  fromBridge({ t: 'progress', id: '1', pos: 3.5, wall: 1 });
  fromBridge({ t: 'hello' });
  assert.deepEqual(h.lines.slice(n0), [
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

test('only what the bridge sends is passed on, never the host\'s own messages', async () => {
  const { hosts, fromBridge, openWindow } = setup();
  await openWindow();
  const h = hosts[0];
  const n = h.lines.length;
  fromBridge({ t: 'host.cover', url: 'x', cover: 'javascript:1' });
  fromBridge({ t: 'host.settings', data: {} });
  fromBridge({ t: 'whatever' });
  fromBridge({ c: 'toggle' });
  assert.equal(h.lines.length, n);
  for (const t of ['snapshot', 'track', 'state', 'progress', 'liked', 'mode', 'volume', 'roaming', 'reply']) fromBridge({ t });
  assert.deepEqual(h.lines.slice(n).map((l) => l.msg.t), ['snapshot', 'track', 'state', 'progress', 'liked', 'mode', 'volume', 'roaming', 'reply']);
});

test('only the session that said hello is the bridge', async () => {
  const { cdp, hosts, relay, fromBridge, openWindow } = setup();
  // an open from a session that never said hello opens nothing
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } }, 'S9');
  await tick();
  assert.equal(hosts.length, 0);
  assert.equal(relay.isOpen, false);
  await openWindow();
  const n = hosts[0].lines.length;
  fromBridge({ t: 'progress', id: '1', pos: 1, wall: 1 }, 'S9');
  assert.equal(hosts[0].lines.length, n, 'not passed on');
  hosts[0].say({ from: 'web', msg: { c: 'toggle' } });
  await tick();
  assert.equal(cdp.evals().at(-1).sid, 'S1', 'commands still go to the bridge');
});

test('binding calls from any other document are ignored', async () => {
  const seen = [];
  const { cdp, hosts, relay, fromBridge } = setup({ fromBridgeContext: (sid, id) => { seen.push([sid, id]); return id === 1; } });
  fromBridge({ t: 'hello' }, 'S1', 7);
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } }, 'S1', 7);
  await tick();
  assert.deepEqual(seen, [['S1', 7], ['S1', 7]]);
  assert.equal(hosts.length, 0);
  assert.equal(cdp.calls.length, 0);
  fromBridge({ t: 'hello' }, 'S1', 1);
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } }, 'S1', 1);
  await tick();
  assert.equal(relay.isOpen, true);
  // without the injector's check nothing is accepted
  const cdp2 = fakeCdp();
  const relay2 = createLyricsRelay({ getCdp: () => cdp2, spawnHost: () => fakeHost(), paths: PATHS });
  relay2.onBindingCalled({ name: BINDING, payload: JSON.stringify({ t: 'hello' }), executionContextId: 1 }, 'S1');
  await tick();
  assert.equal(cdp2.calls.length, 0);
});

test('the bridge\'s context is the default world of the top frame of an orpheus://orpheus/ page', () => {
  const s = { targetId: 'T', frameId: 'T', url: 'orpheus://orpheus/app.html#/', contexts: new Map([[1, 'T'], [2, 'CHILD']]) };
  assert.equal(isBridgeContext(s, 1), true);
  assert.equal(isBridgeContext(s, 2), false, 'a frame inside the page');
  assert.equal(isBridgeContext(s, 3), false, 'an isolated world, or a context already gone');
  assert.equal(isBridgeContext({ ...s, frameId: null }, 1), true, 'the top frame is the target until a navigation says');
  assert.equal(isBridgeContext({ ...s, url: 'https://music.163.com/x' }, 1), false);
  assert.equal(isBridgeContext({ ...s, url: 'about:blank' }, 1), false);
  assert.equal(isBridgeContext({ ...s, url: 'orpheus://orpheus.evil/app.html' }, 1), false);
  assert.equal(isBridgeContext(undefined, 1), false);
});

test('a hello while the window is open re-activates a reloaded bridge', async () => {
  const { cdp, openWindow, fromBridge } = setup();
  await openWindow();
  fromBridge({ t: 'hello' }, 'S2');
  await tick();
  const ev = cdp.evals().at(-1);
  assert.equal(ev.sid, 'S2', 'the new session runs the bridge now');
  assert.deepEqual(cdp.commands(), [{ c: 'active', v: true }]);
});

test('a page request gets an error reply when NCM\'s page has no bridge', async () => {
  const { hosts, openWindow } = setup({ evalValue: (expr) => (/"c":"fetch"/.test(expr) ? 'no-bridge' : true) });
  await openWindow();
  hosts[0].say({ from: 'web', msg: { c: 'fetch', rid: 7, url: 'https://music.163.com/api/x' } });
  await tick();
  await tick();
  assert.deepEqual(hosts[0].lines.at(-1), { to: 'web', msg: { t: 'reply', rid: 7, ok: false, error: 'NCM page not ready' } });

  // and when the session is gone
  const s2 = setup();
  await s2.openWindow();
  s2.relay.detachSession('S1');
  s2.hosts[0].say({ from: 'web', msg: { c: 'rnpSettings', rid: 8 } });
  await tick();
  await tick();
  assert.deepEqual(s2.hosts[0].lines.at(-1), { to: 'web', msg: { t: 'reply', rid: 8, ok: false, error: 'NCM page not ready' } });
});

test('closing raises NCM at the window\'s frame, then hides the window', async () => {
  const { cdp, hosts, relay, openWindow } = setup();
  await openWindow();
  const frame = { x: 5, y: 80, w: 1200, h: 800 };
  const cocoa = { x: 5, y: 76, w: 1200, h: 800 };
  hosts[0].say({ from: 'host', op: 'closing', frame, cocoa });
  await tick();
  await tick();
  assert.deepEqual(cdp.commands(), [{ c: 'showNcm', frame, cocoa }, { c: 'active', v: false }]);
  assert.equal(relay.isOpen, false);
  assert.ok(!hosts[0].lines.some((l) => l.op === 'hide'), 'not hidden before NCM is up');
  await wait(200);
  assert.deepEqual(hosts[0].lines.at(-1), { to: 'host', op: 'hide' });
});

test('opening again while closing keeps the window', async () => {
  const { cdp, hosts, relay, fromBridge, openWindow } = setup();
  await openWindow();
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

test('minimizing moves NCM to the window\'s frame, minimizes it and makes the bridge inactive', async () => {
  const { cdp, hosts, relay, openWindow } = setup();
  await openWindow();
  const frame = { x: 5, y: 80, w: 1200, h: 800 };
  const cocoa = { x: 5, y: 76, w: 1200, h: 800 };
  hosts[0].say({ from: 'host', op: 'minimizing', frame, cocoa });
  await tick();
  assert.deepEqual(cdp.commands(), [{ c: 'minimizeNcm', frame, cocoa }, { c: 'active', v: false }]);
  assert.equal(relay.isOpen, false);
});

test('full screen is NCM\'s: the green button asks the bridge, and NCM\'s change reaches the host while open', async () => {
  const { cdp, hosts, fromBridge, openWindow } = setup();
  await openWindow();
  const before = cdp.commands().length;
  hosts[0].say({ from: 'host', op: 'setFullscreen', v: true });
  await tick();
  assert.deepEqual(cdp.commands().slice(before), [{ c: 'setFullscreen', v: true }]);
  const frame = { x: 0, y: 0, w: 1470, h: 956 };
  fromBridge({ t: 'fullscreen', v: true, frame });
  await tick();
  assert.deepEqual(hosts[0].lines.at(-1), { to: 'host', op: 'ncmFullscreen', v: true, frame });
  assert.ok(!hosts[0].lines.some((l) => l.to === 'web' && l.msg?.t === 'fullscreen'), 'not for the page');
});

test('the host exiting makes the bridge inactive, and the next open starts a new host', async () => {
  const { cdp, hosts, relay, fromBridge, openWindow } = setup({ quickExitMs: 0 }); // not a quick death
  await openWindow();
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
  fromBridge({ t: 'hello' });
  await tick();
  cdp.calls.length = 0;
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  assert.deepEqual(cdp.commands(), [{ c: 'fallback' }]);
  assert.equal(relay.isOpen, false);

  // the same without a binary on disk
  const cdp2 = fakeCdp();
  const relay2 = createLyricsRelay({ getCdp: () => cdp2, fromBridgeContext: () => true, paths: { ...PATHS, bin: path.join(DP, 'missing') } });
  relay2.onBindingCalled({ name: BINDING, payload: JSON.stringify({ t: 'hello' }) }, 'S1');
  relay2.onBindingCalled({ name: BINDING, payload: JSON.stringify({ t: 'open', frame: {} }) }, 'S1');
  await tick();
  assert.deepEqual(cdp2.commands(), [{ c: 'active', v: false }, { c: 'fallback' }]);

  // and once the window is turned off
  const s3 = setup();
  s3.fromBridge({ t: 'hello' });
  s3.relay.dispose();
  s3.fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  assert.equal(s3.hosts.length, 0);
  assert.deepEqual(s3.cdp.commands().at(-1), { c: 'fallback' });
});

test('a host that dies soon after an open lets NCM open its own page; three in a row and none starts again', async () => {
  const { cdp, hosts, relay, fromBridge, openWindow } = setup({ prewarmMs: 5 });
  await openWindow();
  hosts[0].emit('exit', null, 'SIGKILL'); // Gatekeeper
  await tick();
  assert.deepEqual(cdp.commands().at(-1), { c: 'fallback' });
  assert.equal(relay.isOpen, false);
  // a pre-warmed host that dies before saying anything counts too
  fromBridge({ t: 'hello' });
  await wait(30);
  assert.equal(hosts.length, 2);
  hosts[1].emit('exit', 1, null);
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  assert.equal(hosts.length, 3);
  hosts[2].emit('exit', 1, null);
  await tick();
  // given up: the next open is NCM's at once, and no pre-warm starts one
  cdp.calls.length = 0;
  fromBridge({ t: 'hello' });
  await wait(30);
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  assert.equal(hosts.length, 3);
  assert.deepEqual(cdp.commands().at(-1), { c: 'fallback' });
  relay.dispose();
});

test('a host that lived and talked resets the count of quick deaths', async () => {
  const { cdp, hosts, fromBridge, openWindow } = setup({ quickExitMs: 20 });
  await openWindow();
  hosts[0].emit('exit', 1, null);
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  hosts[1].emit('exit', 1, null);
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  await wait(40);
  hosts[2].say({ from: 'host', op: 'log', msg: 'fine' });
  hosts[2].emit('exit', 1, null);
  await tick();
  assert.deepEqual(cdp.commands().at(-1), { c: 'active', v: false }, 'not quick: no fallback');
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  assert.equal(hosts.length, 4, 'still started');
});

test('an open NCM\'s page cannot be told about hides the window again', async () => {
  const { hosts, relay, fromBridge } = setup({ evalValue: (expr) => (/"c":"active","v":true/.test(expr) ? 'no-bridge' : true) });
  fromBridge({ t: 'hello' });
  fromBridge({ t: 'open', frame: { x: 0, y: 0, w: 1, h: 1 } });
  await tick();
  await tick();
  assert.deepEqual(hosts[0].lines.at(-1), { to: 'host', op: 'hide' });
  assert.equal(relay.isOpen, false);
});

test('commands only the injector sends are refused from the page; the page\'s own pass', async () => {
  const { cdp, hosts, openWindow } = setup();
  await openWindow();
  for (const c of ['detach', 'fallback', 'setFullscreen', 'showNcm', 'minimizeNcm', 'active']) hosts[0].say({ from: 'web', msg: { c, v: true } });
  await tick();
  assert.deepEqual(cdp.commands(), []);
  // every command resources/lyrics/web/js sends (send() and request())
  const page = ['hello', 'snapshot', 'drawn', 'toggle', 'prev', 'next', 'seek', 'volume', 'like', 'mode', 'playlist', 'dislike',
    'nav', 'fetch', 'rnpSettings', 'ncmAction', 'accentPixels'];
  for (const c of page) hosts[0].say({ from: 'web', msg: { c } });
  await tick();
  assert.deepEqual(cdp.commands().map((m) => m.c), page);
});

test('a spawn that fails asynchronously counts as an exit', async () => {
  const { hosts, relay, openWindow } = setup();
  await openWindow();
  hosts[0].pid = undefined;
  hosts[0].emit('error', new Error('ENOENT'));
  await tick();
  assert.equal(relay.hostRunning, false);
  assert.equal(relay.isOpen, false);
});

test('development eval and snapshot calls are answered by the host', async () => {
  const { hosts, relay, openWindow } = setup();
  await assert.rejects(relay.evalInWindow('1'), /not running/);
  await openWindow();
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
  const { cdp, hosts, openWindow } = setup();
  await openWindow();
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

test('NCM going away hides the window, stops its clock and ends the host', async () => {
  const { cdp, hosts, relay, fromBridge, openWindow } = setup({ prewarmMs: 5 });
  await openWindow();
  const pending = assert.rejects(relay.evalInWindow('1'), /NCM is gone/);
  relay.ncmGone();
  await pending;
  assert.deepEqual(hosts[0].lines.slice(-2), [{ to: 'web', msg: { t: 'state', playing: false } }, { to: 'host', op: 'hide' }]);
  assert.equal(hosts[0].stdin.writable, false, 'the host quits (and a full-screen Space goes with it)');
  assert.equal(relay.isOpen, false);
  assert.equal(relay.hostRunning, false);
  // nothing goes to the old session any more
  hosts[0].say({ from: 'web', msg: { c: 'toggle' } });
  await tick();
  assert.equal(cdp.calls.length, 0);
  // NCM back: its bridge says hello and the host is pre-warmed again
  fromBridge({ t: 'hello' }, 'S2');
  await wait(30);
  assert.equal(hosts.length, 2);
  assert.ok(!hosts[1].lines.some((l) => l.op === 'show'));
  relay.dispose();

  // a pre-warm still waiting is cancelled; with no host nothing is written
  const s2 = setup({ prewarmMs: 5 });
  s2.fromBridge({ t: 'hello' });
  s2.relay.ncmGone();
  await wait(30);
  assert.equal(s2.hosts.length, 0);
});

test('detaching tells the bridge to let NCM\'s own page open again, briefly', async () => {
  const { cdp, relay, fromBridge } = setup();
  assert.equal(await relay.detachBridge(), 'no-bridge', 'no bridge yet: nothing to wait for');
  fromBridge({ t: 'hello' });
  await tick();
  cdp.calls.length = 0;
  await relay.detachBridge();
  assert.deepEqual(cdp.commands(), [{ c: 'detach' }]);
});

test('dispose ends the host, makes the bridge inactive and removes the binding', async () => {
  const { cdp, hosts, relay, openWindow } = setup();
  await relay.attachSession('S1');
  await relay.attachSession('S2');
  relay.detachSession('S2');
  await openWindow();
  relay.dispose();
  assert.equal(hosts[0].stdin.writable, false);
  assert.equal(relay.hostRunning, false);
  assert.equal(relay.isOpen, false);
  assert.deepEqual(cdp.commands(), [{ c: 'active', v: false }]);
  assert.deepEqual(cdp.calls.filter((c) => c.method === 'Runtime.removeBinding'), [
    { method: 'Runtime.removeBinding', params: { name: BINDING }, sid: 'S1' },
  ]);
});
