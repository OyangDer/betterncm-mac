// The lyrics window's relay (LYRICS-WINDOW.md): NCM's page (lyrics-bridge.js, over a CDP binding and
// Runtime.evaluate) <-> the host process BNCMLyrics (stdin/stdout, one JSON object per line).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getDataPath, PROJECT_ROOT, readConfigKey } from './config.mjs';
import { log } from './log.mjs';

export const BINDING = '__bncmLyricsPost';
const HIDE_AFTER_NCM_MS = 120; // let NCM's window come up before ours goes, so nothing flashes

export function lyricsWindowEnabled() {
  return readConfigKey('mac.lyricsWindow') === 'true';
}

export function hostPaths(root = PROJECT_ROOT) {
  return {
    bin: path.join(root, 'resources/lyrics/BNCMLyrics'),
    web: path.join(root, 'resources/lyrics/web'),
    data: getDataPath(),
    cache: path.join(os.homedir(), 'Library/Caches/BetterNCM-mac/lyrics'),
  };
}

/**
 * getCdp: () => the browser connection (send(method, params, sessionId)).
 * spawnHost: injectable for tests; defaults to child_process.spawn of the host binary.
 */
export function createLyricsRelay({ getCdp, root = PROJECT_ROOT, spawnHost = null } = {}) {
  let bridgeSid = null; // the session whose page runs the bridge (NCM's main window)
  let host = null;
  let open = false;
  const evals = new Map();
  let evalSeq = 0;

  function evalInBridge(cmd) {
    const cdp = getCdp();
    if (!cdp || cdp.closed || !bridgeSid) return Promise.resolve(null);
    const expression = `window.__bncmLyricsBridge ? window.__bncmLyricsBridge.cmd(${JSON.stringify(cmd)}) : 'no-bridge'`;
    return cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, bridgeSid, { timeout: 5000 })
      .then((r) => r?.result?.value ?? null)
      .catch((e) => { log('lyrics: bridge command failed:', cmd.c, e.message); return null; });
  }

  function hostCall(fields) {
    if (!host) return Promise.reject(new Error('the lyrics window is not running'));
    const id = ++evalSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { evals.delete(id); reject(new Error('timed out')); }, 15000);
      evals.set(id, { resolve, reject, timer });
      toHost({ to: 'host', id, ...fields });
    });
  }

  function toHost(obj) {
    if (!host?.stdin?.writable) return;
    try { host.stdin.write(JSON.stringify(obj) + '\n'); } catch (e) { log('lyrics: write to host failed:', e.message); }
  }

  function startHost() {
    if (host) return host;
    const p = hostPaths(root);
    if (!spawnHost && !fs.existsSync(p.bin)) {
      log('lyrics: host binary missing at', p.bin);
      return null;
    }
    try { fs.mkdirSync(p.cache, { recursive: true }); } catch { /* the host retries */ }
    const args = ['--web', p.web, '--data', p.data, '--cache', p.cache];
    let child;
    try {
      // mac.lyricsTest (development only): the window draws and animates even while it cannot be
      // seen, e.g. with the screen locked, so it can be checked by snapshots.
      const env = readConfigKey('mac.lyricsTest') === 'true' ? { ...process.env, BNCM_LYRICS_TEST: '1' } : process.env;
      child = spawnHost ? spawnHost(p.bin, args) : spawn(p.bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (e) {
      log('lyrics: cannot start the host:', e.message);
      return null;
    }
    host = child;
    log(`lyrics: host started (pid ${child.pid ?? '?'})`);
    let buf = '';
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { log('lyrics: bad line from host:', line.slice(0, 200)); continue; }
        onHost(msg);
      }
    });
    let ebuf = '';
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (chunk) => {
      ebuf += chunk;
      let i;
      while ((i = ebuf.indexOf('\n')) >= 0) { log(ebuf.slice(0, i)); ebuf = ebuf.slice(i + 1); }
    });
    child.on('error', (e) => { log('lyrics: host error:', e.message); });
    child.on('exit', (code, sig) => {
      log(`lyrics: host exited (${sig ?? code})`);
      if (host === child) host = null;
      if (open) { open = false; evalInBridge({ c: 'active', v: false }); }
    });
    return child;
  }

  async function onHost(msg) {
    if (msg.from === 'web') {
      const m = msg.msg;
      if (m && typeof m.c === 'string') {
        const r = await evalInBridge(m);
        if (r === 'no-bridge' && m.rid) toHost({ to: 'web', msg: { t: 'reply', rid: m.rid, ok: false, error: 'NCM page not ready' } });
      }
      return;
    }
    if (msg.from !== 'host') return;
    if (msg.op === 'closing') {
      open = false;
      await evalInBridge({ c: 'showNcm', frame: msg.frame, cocoa: msg.cocoa });
      setTimeout(() => toHost({ to: 'host', op: 'hide' }), HIDE_AFTER_NCM_MS);
      evalInBridge({ c: 'active', v: false });
    } else if (msg.op === 'minimizing') {
      open = false;
      evalInBridge({ c: 'minimizeNcm' });
      evalInBridge({ c: 'active', v: false });
    } else if (msg.op === 'evalResult') {
      const w = evals.get(msg.id);
      if (w) { evals.delete(msg.id); clearTimeout(w.timer); if (msg.error) w.reject(new Error(msg.error)); else w.resolve(msg.value); }
    } else if (msg.op === 'log') {
      log('lyrics host:', msg.msg);
    }
  }

  async function onBridge(msg, sid) {
    if (msg.t === 'hello') {
      bridgeSid = sid;
      log('lyrics: bridge ready');
      if (host) toHost({ to: 'web', msg });
      return;
    }
    if (sid !== bridgeSid) bridgeSid = sid;
    if (msg.t === 'open') {
      if (!startHost()) {
        // no window to show: let NCM open its own page after all
        evalInBridge({ c: 'fallback' });
        return;
      }
      open = true;
      toHost({ to: 'web', msg });
      toHost({ to: 'host', op: 'show', frame: msg.frame, fullscreen: !!msg.fullscreen });
      evalInBridge({ c: 'active', v: true });
      return;
    }
    toHost({ to: 'web', msg });
  }

  return {
    /** Every page session gets the binding; only NCM's main window runs the bridge. */
    async attachSession(sessionId) {
      const cdp = getCdp();
      await cdp.send('Runtime.addBinding', { name: BINDING }, sessionId, { timeout: 5000 });
    },
    onBindingCalled(p, sid) {
      if (p?.name !== BINDING) return;
      let msg;
      try { msg = JSON.parse(p.payload); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      onBridge(msg, sid).catch((e) => log('lyrics: bridge message failed:', e.message));
    },
    detachSession(sid) {
      if (sid === bridgeSid) bridgeSid = null;
    },
    dispose() {
      if (host) {
        try { host.stdin.end(); } catch { /* gone */ }
        const h = host;
        setTimeout(() => { try { h.kill(); } catch { /* gone */ } }, 1000).unref?.();
        host = null;
      }
    },
    /** Development: the value of `js` evaluated in the window's page (a promise is awaited). */
    evalInWindow(js) {
      return hostCall({ op: 'eval', js });
    },
    /** Development: a PNG of the window's page written to `path`. */
    snapshotWindow(path) {
      return hostCall({ op: 'snapshot', path });
    },
    get isOpen() { return open; },
    get hostRunning() { return !!host; },
  };
}
