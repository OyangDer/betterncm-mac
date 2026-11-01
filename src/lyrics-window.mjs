// The lyrics window's relay (LYRICS-WINDOW.md): NCM's page (lyrics-bridge.js, over a CDP binding and
// Runtime.evaluate) <-> the host process BNCMLyrics (stdin/stdout, one JSON object per line).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getDataPath, MAC_VERSION, PROJECT_ROOT, readConfigKey } from './config.mjs';
import { log } from './log.mjs';

export const BINDING = '__bncmLyricsPost';
const HIDE_AFTER_NCM_MS = 120; // let NCM's window come up before ours goes, so nothing flashes
// Start the host, hidden, this long after NCM's page is ready, so the first open is instant.
const PREWARM_MS = 4000;
const NO_BRIDGE = 'no-bridge';
const DETACH_MS = 300; // shutting down: how long the bridge gets to let go of NCM's page
// What the bridge posts; anything else (the host's own host.* messages above all) is not passed on.
const BRIDGE_TYPES = new Set(['hello', 'open', 'snapshot', 'track', 'state', 'progress', 'liked', 'mode', 'volume', 'roaming', 'reply', 'fullscreen']);
// Asks a page's bridge to say hello again: its first hello can come before the binding is there
// (an injector attaching to a running NCM, or re-registering after a config change).
const HELLO = `window.__bncmLyricsBridge ? window.__bncmLyricsBridge.cmd({ c: 'hello' }) : '${NO_BRIDGE}'`;

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
 * Whether a binding call comes from where the bridge runs: the default world of the top frame of an
 * orpheus://orpheus/ page. Every document in an attached target has the binding (it stays across
 * navigations and is in every frame), so the call's execution context is what tells them apart.
 * `s` is the injector's record of the session: `url` and `frameId` of its top frame (the target id
 * until a navigation says otherwise) and `contexts`, default contexts' id -> frame id.
 */
export function isBridgeContext(s, contextId) {
  if (!s || typeof s.url !== 'string' || !s.url.startsWith('orpheus://orpheus/')) return false;
  const top = s.frameId || s.targetId;
  return !!top && s.contexts?.get(contextId) === top;
}

/**
 * getCdp: () => the browser connection (send(method, params, sessionId)).
 * fromBridgeContext: (sessionId, executionContextId) => whether a binding call may be the bridge's
 *   (the injector's isBridgeContext); nothing is accepted without it.
 * spawnHost: injectable for tests; defaults to child_process.spawn of the host binary.
 * paths: injectable for tests; defaults to hostPaths(root).
 */
export function createLyricsRelay({ getCdp, fromBridgeContext = () => false, root = PROJECT_ROOT, spawnHost = null, paths = null,
  prewarmMs = PREWARM_MS } = {}) {
  let bridgeSid = null; // the session whose page runs the bridge (NCM's main window)
  let host = null;
  let prewarm = null;
  let disposed = false;
  let open = false;
  const bound = new Set(); // sessions given the binding
  const evals = new Map();
  let evalSeq = 0;

  /**
   * The command's return value, or NO_BRIDGE when it could not run in NCM's page. A command's
   * promise is not awaited: requests answer through the binding themselves, and awaiting a slow
   * fetch or a dialog the user is filling in would time out here and fail the request early.
   */
  function evalInBridge(cmd, timeout = 5000) {
    const cdp = getCdp();
    if (!cdp || cdp.closed || !bridgeSid) return Promise.resolve(NO_BRIDGE);
    const expression = `window.__bncmLyricsBridge ? window.__bncmLyricsBridge.cmd(${JSON.stringify(cmd)}) : '${NO_BRIDGE}'`;
    return cdp.send('Runtime.evaluate', { expression, awaitPromise: false, returnByValue: true }, bridgeSid, { timeout })
      .then((r) => (r?.exceptionDetails ? NO_BRIDGE : r?.result?.value ?? null))
      .catch((e) => { log('lyrics: bridge command failed:', cmd.c, e.message); return NO_BRIDGE; });
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

  function rejectPending(why) {
    for (const [id, w] of evals) { clearTimeout(w.timer); w.reject(new Error(why)); evals.delete(id); }
  }

  function toHost(obj) {
    if (!host?.stdin?.writable) return;
    try { host.stdin.write(JSON.stringify(obj) + '\n'); } catch (e) { log('lyrics: write to host failed:', e.message); }
  }

  function startHost() {
    if (host) return host;
    if (disposed) return null;
    const p = paths || hostPaths(root);
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
    // a failed spawn reports 'error' and maybe no 'exit'
    let gone = false;
    const onGone = (why) => {
      if (gone) return;
      gone = true;
      log(`lyrics: host exited (${why})`);
      if (host !== child) return;
      host = null;
      rejectPending('the lyrics window exited');
      if (open) { open = false; evalInBridge({ c: 'active', v: false }); }
    };
    child.on('error', (e) => { log('lyrics: host error:', e.message); if (child.pid == null) onGone(e.message); });
    child.on('exit', (code, sig) => onGone(sig ?? code));
    return child;
  }

  /** Ends the host: it quits when its stdin closes, and is killed if it has not a second later. */
  function stopHost() {
    if (!host) return;
    try { host.stdin.end(); } catch { /* gone */ }
    const h = host;
    setTimeout(() => { try { h.kill(); } catch { /* gone */ } }, 1000).unref?.();
    host = null;
  }

  async function onHost(msg) {
    if (msg.from === 'web') {
      const m = msg.msg;
      if (m && typeof m.c === 'string') {
        const r = await evalInBridge(m);
        if (r === NO_BRIDGE && m.rid) toHost({ to: 'web', msg: { t: 'reply', rid: m.rid, ok: false, error: 'NCM page not ready' } });
      }
      return;
    }
    if (msg.from !== 'host') return;
    if (msg.op === 'closing') {
      open = false;
      await evalInBridge({ c: 'showNcm', frame: msg.frame, cocoa: msg.cocoa });
      // opened again meanwhile: the window stays
      setTimeout(() => { if (!open) toHost({ to: 'host', op: 'hide' }); }, HIDE_AFTER_NCM_MS);
      if (!open) evalInBridge({ c: 'active', v: false });
    } else if (msg.op === 'setFullscreen') {
      // the window's green button: full screen is NCM's, which the window then follows
      evalInBridge({ c: 'setFullscreen', v: !!msg.v });
    } else if (msg.op === 'minimizing') {
      open = false;
      evalInBridge({ c: 'minimizeNcm', frame: msg.frame, cocoa: msg.cocoa });
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
      const fresh = sid !== bridgeSid;
      bridgeSid = sid;
      if (fresh) log('lyrics: bridge ready');
      // A bridge left active by an injector that ended with the window open (killed, crashed)
      // would keep sending progress and keep NCM's play bar slowed.
      if (!open) evalInBridge({ c: 'active', v: false });
      if (!host) {
        if (prewarmMs != null && !prewarm && !disposed) {
          prewarm = setTimeout(() => { prewarm = null; if (!disposed) startHost(); }, prewarmMs);
          prewarm.unref?.();
        }
        return;
      }
      toHost({ to: 'web', msg });
      // NCM's page reloaded under the open window: its new bridge starts inactive
      if (open) evalInBridge({ c: 'active', v: true });
      return;
    }
    // only the session that said hello runs the bridge
    if (sid !== bridgeSid || !BRIDGE_TYPES.has(msg.t)) return;
    if (msg.t === 'fullscreen') {
      // NCM entered or left full screen: the window lays itself over it (host), not the page
      log(`lyrics: NCM full screen ${msg.v ? 'on' : 'off'}`, JSON.stringify(msg.frame), open ? '' : '(window closed)');
      if (open) toHost({ to: 'host', op: 'ncmFullscreen', v: !!msg.v, frame: msg.frame });
      return;
    }
    if (msg.t === 'open') {
      if (!startHost()) {
        // no window to show: let NCM open its own page after all
        evalInBridge({ c: 'fallback' });
        return;
      }
      open = true;
      toHost({ to: 'web', msg: { ...msg, version: MAC_VERSION } });
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
      bound.add(sessionId);
      disposed = false; // the window was turned on again
      // Not awaited: a new target waits for the debugger until its setup is done. A page that
      // has no bridge yet says hello itself once it boots.
      cdp.send('Runtime.evaluate', { expression: HELLO, returnByValue: true }, sessionId, { timeout: 5000 })
        .catch(() => { /* not a page, or it went away */ });
    },
    onBindingCalled(p, sid) {
      if (p?.name !== BINDING || !fromBridgeContext(sid, p.executionContextId)) return;
      let msg;
      try { msg = JSON.parse(p.payload); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      onBridge(msg, sid).catch((e) => log('lyrics: bridge message failed:', e.message));
    },
    detachSession(sid) {
      bound.delete(sid);
      if (sid === bridgeSid) bridgeSid = null;
    },
    /**
     * NCM's connection is gone (NCM quit, or is restarting itself): the window's controls lead
     * nowhere. The window goes with its host, which also takes a full-screen window's Space away
     * (hiding alone leaves it); the next hello starts a fresh host.
     */
    ncmGone() {
      bridgeSid = null;
      bound.clear();
      clearTimeout(prewarm);
      prewarm = null;
      rejectPending('NCM is gone');
      if (open || host) {
        open = false;
        toHost({ to: 'web', msg: { t: 'state', playing: false } });
        toHost({ to: 'host', op: 'hide' });
        stopHost();
      }
    },
    /**
     * Shutting down while NCM may keep running: the bridge stops sending and lets NCM open its own
     * page again. Best effort, and short.
     */
    detachBridge() {
      return evalInBridge({ c: 'detach' }, DETACH_MS);
    },
    /** The window is turned off (or the injector stops). */
    dispose() {
      disposed = true;
      clearTimeout(prewarm);
      prewarm = null;
      if (open) evalInBridge({ c: 'active', v: false });
      open = false;
      rejectPending('the lyrics window was closed');
      stopHost();
      const cdp = getCdp();
      if (cdp && !cdp.closed) {
        for (const sid of bound) cdp.send('Runtime.removeBinding', { name: BINDING }, sid).catch(() => { /* gone */ });
      }
      bound.clear();
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
