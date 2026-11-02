// The long-running injector: API server + CDP attach + per-target document-start injection.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  getDataPath, ensureDataDirs, readConfigKey, writeConfigKey, getMacConfig, isSafeMode, getNcmVersion, SAFE_MODE_KEY,
  MAC_VERSION, NCM_APP, PROJECT_ROOT, ncmSupport, TESTED_NCM_LABEL,
} from './config.mjs';
import { log, setLogFile } from './log.mjs';
import { connectBrowser } from './cdp.mjs';
import { alertDialog, ensureNcm, findNcm, isPidAlive, replaceFreshNcm, restartNcm, waitForCdp } from './launcher.mjs';
import { buildInjection } from './bundle.mjs';
import { startServer } from './server.mjs';
import { seedBundledPlugins, seedPluginMarket, extractPackedPlugins, collectHijacks, collectStartupScripts } from './plugins.mjs';
import { openDevtools } from './macos.mjs';
import { createLyricsRelay, isBridgeContext, lyricsWindowEnabled } from './lyrics-window.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETUP_TIMEOUT = 10000;
const RELAUNCH_GRACE_MS = 20000; // how long to wait for NCM to come back after it exits

export function statePath() {
  return path.join(getDataPath(), 'run/state.json');
}

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return null;
  }
}

function lockPath() {
  return path.join(getDataPath(), 'run/injector.lock');
}

// A live bncm-mac process (not a reused pid).
function isInjectorPid(pid) {
  if (!isPidAlive(pid)) return false;
  try {
    return execFileSync('/bin/ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).includes('bncm-mac');
  } catch {
    return false;
  }
}

// A state.json whose injector process is still alive (and is not us). While that injector is
// still starting, the state has no apiPort yet (`starting: true`).
export function liveState() {
  const st = readState();
  if (!st || st.injectorPid === process.pid || !isInjectorPid(st.injectorPid)) return null;
  return st;
}

// Exclusive claim on the data dir (plugins_runtime, state.json). A lock left by a dead
// injector is taken over. Returns the pid of the live owner when the claim fails.
function claimDataDir() {
  const lock = lockPath();
  for (let i = 0; i < 3; i++) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let pid = 0;
    try { pid = Number(fs.readFileSync(lock, 'utf8').trim()); } catch { continue; }
    if (pid && pid !== process.pid && isInjectorPid(pid)) return { ok: false, pid };
    fs.rmSync(lock, { force: true });
  }
  return { ok: false, pid: 0 };
}

function writeState(st) {
  const file = statePath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function wipeRuntime() {
  const dir = path.join(getDataPath(), 'plugins_runtime');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch (e) { log('cannot remove', n, e.message); }
  }
}

// plugins.mjs logs each decision; this is the one-line summary.
function logExtraction(res) {
  if (!res) return;
  log(`plugins: ${res.loaded?.length ?? 0} loaded (${res.loaded?.join(', ') || 'none'}), ${res.skipped?.length ?? 0} skipped`);
}

// Config keys that change the injected script; a change triggers re-registration.
function injectionFingerprint() {
  return JSON.stringify([getMacConfig(), isSafeMode()]);
}

/**
 * Runs until NCM exits (or a signal arrives).
 * mode 'launch': find or launch NCM with the CDP port (may ask to restart it).
 * mode 'attach': only attach to a running NCM on `port` (or the port it was started with).
 * notify: show failures in a dialog too (the Dock/Finder wrapper, where nobody reads stderr).
 * replace: an NCM running without the port is reopened with it at once, without asking (the
 * login agent, for an NCM that was just opened).
 */
export async function runInjector({ mode = 'launch', port = null, notify = false, replace = false } = {}) {
  ensureDataDirs();
  setLogFile(path.join(getDataPath(), 'log/injector.log'));
  log(`betterncm-mac ${MAC_VERSION} starting (${mode}), data dir ${getDataPath()}, NCM ${getNcmVersion()}`);

  const other = liveState();
  if (other) {
    log(`another injector is running (pid ${other.injectorPid}, CDP ${other.cdpPort ?? 'pending'}); not starting a second one`);
    return { alreadyRunning: other };
  }
  // Claim the data dir before touching plugins_runtime; a starting injector can wait minutes
  // (restart dialog, cold launch) before it knows its ports.
  const claim = claimDataDir();
  if (!claim.ok) {
    log(`another injector (pid ${claim.pid || '?'}) holds the data dir; not starting a second one`);
    return { alreadyRunning: liveState() ?? { injectorPid: claim.pid, starting: true } };
  }
  const startedAt = new Date().toISOString();
  try {
    writeState({ injectorPid: process.pid, mode, startedAt, starting: true });
  } catch (e) {
    log('cannot write state.json:', e.message);
  }

  try { seedBundledPlugins(); } catch (e) { log('seedBundledPlugins failed:', e); }
  try { seedPluginMarket(); } catch (e) { log('seedPluginMarket failed:', e); }
  try { logExtraction(extractPackedPlugins()); } catch (e) { log('extractPackedPlugins failed:', e); }

  const apiKey = crypto.randomBytes(32).toString('hex'); // 64 characters
  const sessions = new Map(); // sessionId -> {targetId, scriptId, url, frameId, contexts}
  let cdp = null;
  let cdpPort = null;
  let ncmPid = null;
  let restarting = false;
  let shuttingDown = false;
  let server = null;
  let finish;
  const finished = new Promise((r) => { finish = r; });
  const lyrics = createLyricsRelay({ getCdp: () => cdp, fromBridgeContext: (sid, id) => isBridgeContext(sessions.get(sid), id) });

  function injectionInputs() {
    const safe = isSafeMode();
    let hijacks = [];
    let startupScripts = [];
    if (!safe) {
      try { hijacks = collectHijacks(getNcmVersion()); } catch (e) { log('collectHijacks failed:', e); }
      try { startupScripts = collectStartupScripts(); } catch (e) { log('collectStartupScripts failed:', e); }
    }
    return { apiKey, apiPort: server.port, safe, cfg: getMacConfig(), hijacks, startupScripts };
  }

  // Serialized per session: two overlapping registrations would both add a script and orphan
  // one of them, and the orphan (registered first) would win on every later load.
  function registerScript(sessionId, inputs) {
    const s = sessions.get(sessionId);
    if (!s) return Promise.resolve();
    const run = (s.chain ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (sessions.get(sessionId) !== s) return;
      const source = buildInjection({ ...inputs, targetId: s.targetId });
      if (s.scriptId) {
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: s.scriptId }, sessionId).catch(() => {});
        s.scriptId = null;
      }
      const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId, { timeout: SETUP_TIMEOUT });
      s.scriptId = identifier;
    });
    s.chain = run;
    return run;
  }

  async function setupSession(sessionId, targetInfo, waiting) {
    const { targetId, url } = targetInfo;
    // frameId: the top frame's, which is the target's id; contexts: default worlds' id -> frame id
    sessions.set(sessionId, { targetId, scriptId: null, url, exceptions: 0, frameId: targetId, contexts: new Map() });
    const opt = { timeout: SETUP_TIMEOUT };
    try {
      await cdp.send('Page.enable', {}, sessionId, opt);
      await cdp.send('Runtime.enable', {}, sessionId, opt);
      // before the page runs again, so the lyrics bridge finds its binding at document start
      if (lyricsWindowEnabled()) await lyrics.attachSession(sessionId).catch((e) => log('lyrics binding failed:', e.message));
      await cdp.send('Page.setBypassCSP', { enabled: readConfigKey('mac.bypassCSP') !== 'false' }, sessionId, opt);
      await registerScript(sessionId, injectionInputs());
      log(`injection registered for ${targetId} (${url || 'new target'})`);
    } catch (e) {
      log(`setup of ${targetId} failed:`, e.message);
    } finally {
      if (waiting) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    }
    if (waiting || !sessions.get(sessionId)?.scriptId) return;

    // An already loaded page only gets the injection on its next load. Reload unless it
    // already carries this very injector's globals (e.g. after a websocket reconnect).
    try {
      const expr = `typeof betterncm === 'object' && typeof BETTERNCM_API_KEY !== 'undefined' && BETTERNCM_API_KEY === ${JSON.stringify(apiKey)}`;
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId, opt);
      if (r.result?.value === true) {
        log(`${targetId} is already injected, no reload`);
        return;
      }
      log(`reloading ${targetId} to inject`);
      await cdp.send('Page.reload', {}, sessionId, opt);
    } catch (e) {
      log(`reload of ${targetId} failed:`, e.message);
    }
  }

  function isInjectableUrl(url) {
    return !url || url.startsWith('orpheus://') || url === 'about:blank';
  }

  async function onAttached({ sessionId, targetInfo, waitingForDebuggerOnStart }) {
    if (sessions.has(sessionId)) return; // our own explicit attach, already being set up
    const waiting = !!waitingForDebuggerOnStart;
    const known = [...sessions.values()].some((s) => s.targetId === targetInfo.targetId);
    if (known || targetInfo.type !== 'page' || !isInjectableUrl(targetInfo.url)) {
      if (waiting) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      return;
    }
    // A target that is already running must be an orpheus page to be worth a reload.
    if (!waiting && !targetInfo.url?.startsWith('orpheus://')) {
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      return;
    }
    await setupSession(sessionId, targetInfo, waiting);
  }

  function dropTarget(targetId) {
    for (const [sid, s] of sessions) if (s.targetId === targetId) sessions.delete(sid);
  }

  async function attachBrowser() {
    cdp = await connectBrowser(cdpPort);
    cdp.on('Target.attachedToTarget', (p) => { onAttached(p).catch((e) => log('attach handler:', e)); });
    cdp.on('Target.detachedFromTarget', (p) => { sessions.delete(p.sessionId); lyrics.detachSession(p.sessionId); });
    cdp.on('Runtime.bindingCalled', (p, sid) => lyrics.onBindingCalled(p, sid));
    cdp.on('Target.targetDestroyed', (p) => dropTarget(p.targetId));
    cdp.on('Runtime.exceptionThrown', (p, sid) => {
      const s = sessions.get(sid);
      if (!s || s.exceptions++ >= 50) return;
      const d = p.exceptionDetails || {};
      const text = d.exception?.description || d.text || '';
      log(`page exception (${s.targetId}): ${text.slice(0, 300)}${d.url ? ` @ ${d.url}:${d.lineNumber}` : ''}`);
    });
    cdp.on('Page.frameNavigated', (p, sid) => {
      const s = sessions.get(sid);
      if (s && !p.frame?.parentId) { s.exceptions = 0; s.url = p.frame?.url; s.frameId = p.frame?.id || s.frameId; }
    });
    // Which document a lyrics binding call comes from (Runtime is enabled for every session).
    cdp.on('Runtime.executionContextCreated', ({ context: c } = {}, sid) => {
      const s = sessions.get(sid);
      if (s && c?.auxData?.isDefault) s.contexts.set(c.id, c.auxData.frameId);
    });
    cdp.on('Runtime.executionContextDestroyed', (p, sid) => { sessions.get(sid)?.contexts.delete(p.executionContextId); });
    cdp.on('Runtime.executionContextsCleared', (_p, sid) => { sessions.get(sid)?.contexts.clear(); });
    cdp.once('close', () => { onBrowserClose().catch((e) => log('reconnect failed:', e)); });

    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

    // Browser-level auto-attach normally reports existing pages too; attach any it missed.
    const { targetInfos } = await cdp.send('Target.getTargets');
    for (const t of targetInfos) {
      if (t.type !== 'page' || !t.url.startsWith('orpheus://')) continue;
      if ([...sessions.values()].some((s) => s.targetId === t.targetId)) continue;
      try {
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        if (!sessions.has(sessionId)) await setupSession(sessionId, t, false);
      } catch (e) {
        log(`attach to ${t.targetId} failed:`, e.message);
      }
    }
    log(`attached to CDP on port ${cdpPort}, ${sessions.size} page session(s)`);
  }

  async function onBrowserClose() {
    sessions.clear();
    if (shuttingDown || restarting) return;
    log('browser websocket closed');
    // NCM quit (or is restarting itself): the lyrics window must not stay up over nothing
    lyrics.ncmGone();
    while (!shuttingDown && !restarting) {
      let ncm = await findNcm();
      if (!ncm && mode === 'launch') {
        // NCM restarts itself now and then, and quitting it and reopening it from its own icon
        // looks the same; both come back without the debug port. Wait a little before giving up.
        ncm = await waitForNcmReturn(RELAUNCH_GRACE_MS);
        if (ncm) log(`NCM came back (pid ${ncm.pid})${ncm.port ? '' : ' without the debug port'}`);
      }
      if (!ncm) {
        log('NCM has exited');
        await shutdown(0);
        return;
      }
      if (!ncm.port) {
        if (mode !== 'launch') {
          log('NCM is now running without the debug port; nothing to attach to');
          await shutdown(0);
          return;
        }
        if (await relaunchWithPort(ncm.pid)) return;
        await shutdown(1);
        return;
      }
      ncmPid = ncm.pid;
      cdpPort = ncm.port;
      try {
        await waitForCdp(cdpPort, { timeout: 1000 });
        await attachBrowser();
        saveState();
        return;
      } catch {
        await sleep(1000);
      }
    }
  }

  async function waitForNcmReturn(ms) {
    const deadline = Date.now() + ms;
    while (!shuttingDown && Date.now() < deadline) {
      await sleep(200); // the sooner a portless NCM is caught, the less of it the user sees
      const ncm = await findNcm();
      if (ncm) return ncm;
    }
    return null;
  }

  // In launch mode the user started NCM through BetterNCM, so an NCM that came back without the
  // debug port is put back the way they launched it.
  async function relaunchWithPort(pid) {
    log('NCM is running without the debug port; relaunching it with BetterNCM');
    restarting = true;
    try {
      const r = await replaceFreshNcm(pid, cdpPort);
      ncmPid = r.pid;
      cdpPort = r.port;
      await attachBrowser();
      saveState();
      return true;
    } catch (e) {
      log('relaunch with the debug port failed:', e);
      if (notify && !e.alerted) await failureDialog('网易云音乐重新打开后没有加载 BetterNCM，自动重启也失败了。', e);
      return false;
    } finally {
      restarting = false;
    }
  }

  async function reinjectAll() {
    if (!cdp || cdp.closed) return;
    const inputs = injectionInputs();
    const bypass = inputs.cfg['mac.bypassCSP'] !== 'false';
    await Promise.all([...sessions.keys()].map(async (sid) => {
      try {
        await cdp.send('Page.setBypassCSP', { enabled: bypass }, sid, { timeout: SETUP_TIMEOUT });
        if (lyricsWindowEnabled()) await lyrics.attachSession(sid).catch((e) => log('lyrics binding failed:', e.message));
        await registerScript(sid, inputs);
      } catch (e) {
        log(`re-injection for session ${sid} failed:`, e.message);
      }
    }));
    log(`injection re-registered for ${sessions.size} session(s)`);
  }

  async function reloadAllPages() {
    for (const sid of sessions.keys()) await cdp.send('Page.reload', {}, sid).catch(() => {});
  }

  let reloadingPages = false;
  async function doRestart() {
    if (restarting) return;
    if (mode === 'attach') {
      // attach mode never quits or launches NCM: reload the pages instead.
      if (reloadingPages) return;
      reloadingPages = true;
      try {
        log('restart requested in attach mode: reloading pages instead');
        try { logExtraction(extractPackedPlugins()); } catch (e) { log('extractPackedPlugins failed:', e); }
        await reinjectAll();
        await reloadAllPages();
      } finally {
        reloadingPages = false;
      }
      return;
    }
    restarting = true;
    try {
      log('restarting NCM');
      try { logExtraction(extractPackedPlugins()); } catch (e) { log('extractPackedPlugins failed:', e); }
      const r = await restartNcm(cdpPort);
      ncmPid = r.pid;
      cdpPort = r.port;
      // the old NCM is gone (onBrowserClose skips that while restarting): so is the lyrics window
      lyrics.ncmGone();
      if (cdp && !cdp.closed) cdp.close();
      sessions.clear();
      await attachBrowser();
      saveState();
    } catch (e) {
      log('restart failed:', e);
      if (notify && !e.alerted) await failureDialog('重启网易云音乐失败。', e);
    } finally {
      restarting = false;
    }
    // If NCM went away during the restart and never came back, the normal close path decides.
    if (!cdp || cdp.closed) onBrowserClose().catch((e) => log('reconnect failed:', e));
  }

  function saveState() {
    try {
      writeState({ cdpPort, apiPort: server.port, apiKey, ncmPid, injectorPid: process.pid, mode, startedAt });
    } catch (e) {
      log('cannot write state.json:', e.message);
    }
  }

  let configTimer = null;
  let lastFingerprint = null;
  let lastPluginManager = readConfigKey('mac.pluginManager');
  let lastLyricsWindow = readConfigKey('mac.lyricsWindow');
  function onConfigFileChange() {
    clearTimeout(configTimer);
    configTimer = setTimeout(() => {
      const fp = injectionFingerprint();
      if (fp === lastFingerprint) return;
      lastFingerprint = fp;
      log('injection-relevant config changed');
      // Showing or hiding the plugin manager adds or drops PluginMarket from plugins_runtime.
      const pm = readConfigKey('mac.pluginManager');
      if (pm !== lastPluginManager) {
        lastPluginManager = pm;
        try { logExtraction(extractPackedPlugins()); } catch (e) { log('extractPackedPlugins failed:', e); }
      }
      // The lyrics window replaces RefinedNowPlayingNext, which only goes (or comes back) with a
      // fresh extraction and a page load.
      const lw = readConfigKey('mac.lyricsWindow');
      if (lw !== lastLyricsWindow) {
        lastLyricsWindow = lw;
        if (lw !== 'true') lyrics.dispose();
        try { logExtraction(extractPackedPlugins()); } catch (e) { log('extractPackedPlugins failed:', e); }
        reinjectAll().then(reloadAllPages).catch((e) => log('re-injection failed:', e));
        return;
      }
      reinjectAll().catch((e) => log('re-injection failed:', e));
    }, 300);
  }

  // v2 re-reads dev plugins on every page load; here a change to a dev plugin's scripts or
  // manifest re-registers the injection before the loader's own debounced reload (1000 ms).
  let devTimer = null;
  let disposeDevWatch = null;
  function watchDevPlugins() {
    try {
      const w = fs.watch(path.join(getDataPath(), 'plugins_dev'), { recursive: true }, (_evt, filename) => {
        const f = String(filename ?? '');
        // scripts, manifests, and plugin folders appearing or disappearing at the top level
        if (!f.endsWith('.js') && path.basename(f) !== 'manifest.json' && f.includes('/')) return;
        clearTimeout(devTimer);
        devTimer = setTimeout(() => { reinjectAll().catch((e) => log('re-injection failed:', e)); }, 200);
      });
      w.on('error', () => {});
      disposeDevWatch = () => { clearTimeout(devTimer); w.close(); };
    } catch (e) {
      log('cannot watch plugins_dev:', e.message);
    }
  }

  async function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    log('shutting down');
    fs.unwatchFile(path.join(getDataPath(), 'config.json'), onConfigFileChange);
    disposeDevWatch?.();
    // NCM may keep running: its now-playing page is its own again (before the connection goes)
    await lyrics.detachBridge();
    lyrics.dispose();
    try { if (cdp && !cdp.closed) cdp.close(); } catch { /* ignore */ }
    try { await server?.close(); } catch { /* ignore */ }
    try {
      const st = readState();
      if (st?.injectorPid === process.pid) fs.rmSync(statePath(), { force: true });
    } catch { /* ignore */ }
    // Only the claim holder may clear plugins_runtime; release the claim last.
    let owner = false;
    try { owner = Number(fs.readFileSync(lockPath(), 'utf8').trim()) === process.pid; } catch { /* no lock */ }
    if (owner) {
      wipeRuntime();
      fs.rmSync(lockPath(), { force: true });
    }
    finish(code);
  }

  const onSignal = (sig) => {
    log(`received ${sig}`);
    shutdown(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);

  try {
    server = await startServer({
      apiKey,
      hooks: {
        onReloadPlugin: async () => {
          try { logExtraction(extractPackedPlugins()); } catch (e) { log('extractPackedPlugins failed:', e); }
          await reinjectAll();
        },
        // Answer the page first; the restart itself happens after the reply.
        onRestart: async () => { setTimeout(() => { doRestart(); }, 100); },
        onDevtools: async (targetId) => {
          try { await openDevtools(cdpPort, targetId); } catch (e) { log('openDevtools failed:', e.message); }
        },
        onLyricsEval: (js) => lyrics.evalInWindow(js),
        onLyricsSnapshot: (file) => lyrics.snapshotWindow(file),
        // 卸载 BetterNCM (the plugin panel): `uninstall` in a process of its own, which stops this
        // injector, removes the login agent and the app, and reopens NCM without BetterNCM.
        onUninstall: () => {
          log('uninstalling, as asked from the plugin panel');
          try {
            const out = fs.openSync(path.join(getDataPath(), 'log/uninstall.log'), 'a');
            spawn(process.execPath, [path.join(PROJECT_ROOT, 'bin/bncm-mac.mjs'), 'uninstall'], { detached: true, stdio: ['ignore', out, out] }).unref();
          } catch (e) {
            log('starting the uninstall failed:', e.message);
          }
        },
        onHijackReport: (targetId, ids) => {
          if (ids?.length) log(`hijacks applied in ${targetId}: ${ids.join(', ')}`);
        },
      },
    });
    log(`API server on http://127.0.0.1:${server.port}`);

    if (mode === 'launch') await checkNcmApp(); // attach only needs the port
    const ncm = await ensureNcm({
      preferredPort: Number(readConfigKey('mac.cdpPort')) || 9222,
      launch: mode === 'launch',
      port,
      replace,
    });
    cdpPort = ncm.port;
    ncmPid = ncm.pid;
    saveState();
    await attachBrowser();
    saveState();

    lastFingerprint = injectionFingerprint();
    fs.watchFile(path.join(getDataPath(), 'config.json'), { interval: 1000 }, onConfigFileChange);
    watchDevPlugins();
  } catch (e) {
    log('startup failed:', e.message);
    if (notify && !e.alerted && !e.userCancelled) await failureDialog('BetterNCM 启动失败。', e);
    await shutdown(1);
  }

  // Before NCM is touched: a missing or 2.x NCM cannot work; an untested 3.x gets one warning
  // per version (the wrapper shows it; a terminal user sees the log line).
  async function checkNcmApp() {
    if (!fs.existsSync(path.join(NCM_APP, 'Contents/Info.plist'))) {
      throw new Error(`找不到网易云音乐（${NCM_APP}）。请先安装网易云音乐；装在别处的话，在 config.json 里把 mac.ncmApp `
        + '设为它的 .app 路径，例如 /Volumes/X/NeteaseMusic.app。');
    }
    const ver = getNcmVersion();
    const support = ncmSupport(ver);
    if (support === 'unsupported') {
      throw new Error(`网易云音乐 ${ver} 不受支持：BetterNCM for Mac 只支持 3.x（NetEase Cloud Music ${ver} is not supported; 3.x only）。`);
    }
    if (support === 'untested') {
      log(`NCM ${ver} is untested (tested: ${TESTED_NCM_LABEL}); injecting anyway`);
      if (notify && readConfigKey('mac.warnedNcmVersion', '') !== ver) {
        await alertDialog(`这个网易云音乐版本（${ver}）还没有测试过，BetterNCM 只在 ${TESTED_NCM_LABEL} 上测过。\n`
          + '会照常加载；如果某个插件不正常，先在插件管理里关掉它。\n\n'
          + `NetEase Cloud Music ${ver} is untested (tested: ${TESTED_NCM_LABEL}). BetterNCM loads anyway.`, { critical: false });
        try { writeConfigKey('mac.warnedNcmVersion', ver); } catch (e) { log('cannot save mac.warnedNcmVersion:', e.message); }
      }
    }
  }

  const code = await finished;
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  process.off('SIGHUP', onSignal);
  return { code };
}

// `what` is the one-line Chinese summary; the error itself is usually English.
async function failureDialog(what, e) {
  await alertDialog(`${what}\n${e?.message ?? e}\n\n详细日志 / Log: ${path.join(getDataPath(), 'log/injector.log')}`);
}

export { SAFE_MODE_KEY };
