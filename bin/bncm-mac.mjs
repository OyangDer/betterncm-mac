#!/usr/bin/env node
// betterncm-mac command line. Modules that need the other parts of the project are
// imported lazily, so `help` and `install-app` work on a partial checkout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  NCM_APP, BNCM_VERSION, MAC_VERSION, PROJECT_ROOT, STANDALONE_APP, TESTED_NCM_LABEL, getDataPath, ensureDataDirs,
  getNcmVersion, getNcmBuild, getMacConfig, isSafeMode, ncmSupport,
} from '../src/config.mjs';
import { log, setQuiet } from '../src/log.mjs';
import { alertDialogDetached } from '../src/dialog.mjs';
import { pinToDock, unpinFromDock, isPinned, replaceInDock } from '../src/dock.mjs';

const WRAPPER_ID = 'cc.microblock.betterncm-mac';
const MIN_NODE = 22; // src/cdp.mjs uses the global WebSocket
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);

// Set from --daemon: the Dock/Finder wrapper sends stderr to a log file, so errors there also
// get a dialog.
let daemonMode = false;

const USAGE = `betterncm-mac ${MAC_VERSION} - BetterNCM for NetEase Cloud Music on macOS (via CDP)

Usage: bncm-mac <command> [options]

  launch [--daemon] [--port N] [--replace]
                                 find or launch NCM with the debug port, inject, stay running;
                                 --replace reopens an NCM without the port without asking
  launch --agent                 (the login agent) inject into NCM if it was just opened
                                 without the debug port, quietly; otherwise do nothing
  attach [--port N]              attach to an NCM that already has a debug port; never launches or quits it
  doctor                         print versions, ports, targets, data dir and plugin decisions
  reload                         re-extract plugins in the running injector and reload the pages
  stop                           stop the injector; NCM keeps running (open BetterNCM.app to resume)
  install-agent / uninstall-agent
                                 add or remove the login agent, which gives NCM BetterNCM however
                                 it is opened (its own icon, login, a restart)
  install-app [--dest DIR] [--dock]
                                 (source checkout) write BetterNCM.app (default ~/Applications)
                                 and install the login agent; --dock also pins the app
  setup-app [--dock|--no-dock] [--no-agent]
                                 (self-contained app) copy NCM's icon into it, put it in the Dock in
                                 NCM's place and install the login agent; the app does this itself
                                 the first time it is opened
  uninstall-app [--dest DIR]     remove BetterNCM.app (and its Dock icon)
  uninstall [--purge] [--dest DIR]
                                 remove the login agent and BetterNCM.app, and reopen NCM as it is
                                 without BetterNCM; --purge also deletes the data dir (plugins,
                                 settings, logs)

Data dir: ${getDataPath()} (override with BETTERNCM_PROFILE)
${STANDALONE_APP ? `Commands run as: '${STANDALONE_APP}/Contents/MacOS/BetterNCM' <command>\n` : ''}
Security: while NCM runs with --remote-debugging-port, any local process can control it over
CDP on 127.0.0.1, including the logged-in account and cookies.`;

function fail(msg) {
  process.stderr.write(`bncm-mac: ${msg}\n`);
  process.exit(1);
}

async function showFatal(msg) {
  if (!daemonMode) return;
  try {
    const { alertDialog } = await import('../src/dialog.mjs');
    await alertDialog(`${msg}\n\n详细日志 / Log: ${path.join(getDataPath(), 'log')}`);
  } catch { /* the log still has it */ }
}

function nodeTooOld() {
  return NODE_MAJOR < MIN_NODE
    ? `BetterNCM 需要 Node.js ${MIN_NODE} 或更高版本，当前是 ${process.version}（${process.execPath}）。\n`
      + `BetterNCM needs Node.js ${MIN_NODE} or later; this is ${process.version}. Install a newer Node, then run install-app again.`
    : null;
}

function portArg(v) {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`invalid port: ${v}`);
  return n;
}

// How young an NCM without the debug port may be for the login agent to reopen it: one opened
// from its own icon, by macOS at login or by NCM restarting itself. An older one (left running
// when BetterNCM was installed, or opened while the agent was not loaded) may be playing; it is
// left alone.
const AGENT_FRESH_S = 120;

// `launch --agent`: run by the login agent each time NCM starts (and once when it starts itself).
// Never shows anything; the other cases end at once.
async function cmdAgentLaunch() {
  setQuiet(true);
  const { runInjector, liveState } = await import('../src/injector.mjs');
  const { findNcm, processAge } = await import('../src/launcher.mjs');
  const { setLogFile } = await import('../src/log.mjs');
  ensureDataDirs();
  setLogFile(path.join(getDataPath(), 'log/injector.log'));
  if (liveState()) return 0; // the running injector looks after it (it may be relaunching NCM)
  const ncm = await findNcm();
  if (!ncm) return 0;
  if (!ncm.port) {
    const age = await processAge(ncm.pid);
    if (age == null || age > AGENT_FRESH_S) {
      log(`agent: NCM (pid ${ncm.pid}) has been running ${age ?? '?'} s without the debug port; leaving it alone`);
      return 0;
    }
    log(`agent: NCM (pid ${ncm.pid}) was opened without the debug port ${age} s ago; reopening it with BetterNCM`);
  }
  const res = await runInjector({ mode: 'launch', replace: true });
  return res.alreadyRunning ? 0 : res.code;
}

async function cmdRun(mode, values) {
  if (values.agent) return cmdAgentLaunch();
  if (values.daemon) setQuiet(true);
  const { runInjector, liveState } = await import('../src/injector.mjs');
  const { findNcm, launchNcm } = await import('../src/launcher.mjs');
  const notify = !!values.daemon;
  // --replace (install.sh), and the Dock icon (--daemon): an NCM without the debug port is reopened
  // without asking; opening BetterNCM is asking for it
  const replace = (!!values.replace || !!values.daemon) && mode === 'launch';
  let res = await runInjector({ mode, port: portArg(values.port), notify, replace });
  if (res.alreadyRunning && mode === 'launch') {
    // Opening the wrapper twice should just bring NCM to the front, but only an NCM that has
    // the debug port: the other injector may be winding down (NCM quitting) or restarting it,
    // and `open -a` would start NCM without the port. Wait for it to finish instead.
    // An injector whose NCM was just quit waits a while for NCM to come back (RELAUNCH_GRACE_MS)
    // and does not start it itself, so start it with that injector's port; it attaches on its own.
    const deadline = Date.now() + 15000;
    let started = false;
    for (;;) {
      const ncm = await findNcm();
      if (ncm?.port && liveState()) {
        try { execFileSync('/usr/bin/open', ['-a', NCM_APP]); } catch { /* ignore */ }
        return 0;
      }
      const st = liveState();
      if (!ncm && st?.cdpPort && !started) {
        started = true;
        try { await launchNcm(st.cdpPort); } catch (e) { log('launching NCM for the running injector failed:', e.message); }
      }
      if (!liveState()) {
        res = await runInjector({ mode, port: portArg(values.port), notify, replace });
        if (!res.alreadyRunning) return res.code;
      }
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (res.alreadyRunning) {
    process.stderr.write(`an injector is already running (pid ${res.alreadyRunning.injectorPid})\n`);
    return 0;
  }
  return res.code;
}

async function apiGet(st, route) {
  const res = await fetch(`http://127.0.0.1:${st.apiPort}/api/${route}`, {
    headers: { BETTERNCM_API_KEY: st.apiKey },
    signal: AbortSignal.timeout(60000),
  });
  return { status: res.status, text: await res.text() };
}

async function cmdReload() {
  const { liveState } = await import('../src/injector.mjs');
  const st = liveState();
  if (!st) fail('no running injector (run/state.json missing or stale)');
  if (!st.apiPort) fail(`the injector (pid ${st.injectorPid}) is still starting; try again shortly`);
  const r = await apiGet(st, 'app/reload_plugin');
  if (r.status !== 200) fail(`reload_plugin -> HTTP ${r.status} ${r.text}`);
  console.log('plugins re-extracted, injection re-registered');

  const { connectBrowser } = await import('../src/cdp.mjs');
  const cdp = await connectBrowser(st.cdpPort);
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    for (const t of targetInfos) {
      if (t.type !== 'page' || !t.url.startsWith('orpheus://')) continue;
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      await cdp.send('Page.reload', {}, sessionId);
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      console.log(`reloaded ${t.url}`);
    }
  } finally {
    cdp.close();
  }
  return 0;
}

// The node and CLI paths a generated wrapper starts, or null when it is not ours.
function wrapperTargets(app) {
  try {
    const sh = fs.readFileSync(path.join(app, 'Contents/MacOS/BetterNCM'), 'utf8');
    const unquote = (v) => v?.replace(/^'|'$/g, '').replace(/'\\''/g, "'");
    return { node: unquote(/^NODE=(.*)$/m.exec(sh)?.[1]), cli: unquote(/^CLI=(.*)$/m.exec(sh)?.[1]) };
  } catch {
    return null;
  }
}

async function cmdDoctor() {
  const out = (k, v) => console.log(`${k.padEnd(14)} ${v}`);
  const checks = [];
  const check = (level, what) => checks.push(`${level.padEnd(4)} ${what}`);

  out('betterncm-mac', `${MAC_VERSION} (reports BetterNCM ${BNCM_VERSION}), node ${process.version}`);
  out('project', STANDALONE_APP ? `${STANDALONE_APP} (self-contained)` : PROJECT_ROOT);
  if (nodeTooOld()) check('FAIL', `node ${process.version} is too old; install Node.js ${MIN_NODE} or later`);
  else check('OK', `node ${process.version}`);

  const hasApp = fs.existsSync(path.join(NCM_APP, 'Contents/Info.plist'));
  out('NCM app', hasApp ? `${NCM_APP} ${getNcmVersion()} (build ${getNcmBuild()})` : `${NCM_APP} NOT FOUND`);
  if (!hasApp) {
    check('FAIL', `NetEase Cloud Music not found at ${NCM_APP} (install it, or set mac.ncmApp in config.json)`);
  } else {
    const ver = getNcmVersion();
    const support = ncmSupport(ver);
    if (support === 'ok') check('OK', `NetEase Cloud Music ${ver}`);
    else if (support === 'untested') check('WARN', `NetEase Cloud Music ${ver} is untested (tested: ${TESTED_NCM_LABEL})`);
    else check('FAIL', `NetEase Cloud Music ${ver} is not supported (3.x only)`);
  }

  const wrapper = appPath({});
  const ours = fs.existsSync(wrapper) && bundleIdOf(wrapper) === WRAPPER_ID;
  const selfContained = ours && fs.existsSync(path.join(wrapper, 'Contents/Resources/app/bin/bncm-mac.mjs'));
  const targets = ours && !selfContained ? wrapperTargets(wrapper) : null;
  if (STANDALONE_APP) {
    check('OK', `${STANDALONE_APP} (self-contained, node ${process.version})`);
  } else if (selfContained) {
    check('WARN', `${wrapper} is the self-contained app; it runs its own copy, not this checkout (run install-app here to switch)`);
  } else if (!targets) {
    check('WARN', `${wrapper} not installed (run install-app)`);
  } else if (!targets.cli) {
    check('WARN', `${wrapper} was made by an older install-app (run install-app again)`);
  } else if (path.resolve(targets.cli) !== path.join(PROJECT_ROOT, 'bin/bncm-mac.mjs')) {
    check('WARN', `${wrapper} starts ${targets.cli}, not this checkout (run install-app here to switch)`);
  } else if (!targets.node || !fs.existsSync(targets.node)) {
    check('WARN', `${wrapper} records node ${targets.node ?? '?'}, which is gone; it will look for another (run install-app)`);
  } else {
    check('OK', `${wrapper} (node ${targets.node})`);
  }

  {
    const { agentPlistPath, agentLoaded, AGENT_BINARY } = await import('../src/agent.mjs');
    if (!fs.existsSync(agentPlistPath())) check('WARN', 'login agent not installed: NCM opened from its own icon has no BetterNCM (run install-agent)');
    else if (!fs.existsSync(AGENT_BINARY)) check('FAIL', `login agent: ${AGENT_BINARY} is missing`);
    else if (!agentLoaded()) check('WARN', 'login agent installed but not loaded (run install-agent)');
    else check('OK', 'login agent');
  }

  const { findNcm } = await import('../src/launcher.mjs');
  const ncm = await findNcm();
  out('NCM process', !ncm ? 'not running' : `pid ${ncm.pid}, ${ncm.port ? `CDP port ${ncm.port}` : 'no debug port'}`);

  if (ncm?.port) {
    const { fetchVersion, fetchTargets } = await import('../src/cdp.mjs');
    try {
      const v = await fetchVersion(ncm.port);
      out('CDP', `${v.Browser} on 127.0.0.1:${ncm.port}`);
      for (const t of await fetchTargets(ncm.port)) out('  target', `${t.type} ${t.url} (${t.id})`);
    } catch (e) {
      out('CDP', `unreachable: ${e.message}`);
    }
  }

  const dp = getDataPath();
  out('data dir', `${dp}${fs.existsSync(dp) ? '' : ' (not created yet)'}`);
  for (const [k, v] of Object.entries(getMacConfig())) out('  config', `${k} = ${v}`);
  out('  safe mode', isSafeMode() ? 'ON (no startup scripts, no hijacks)' : 'off');

  const fw = path.join(PROJECT_ROOT, 'dist/framework.js');
  out('framework', fs.existsSync(fw) ? `${fw} (${fs.statSync(fw).size} bytes)` : 'dist/framework.js MISSING (npm run build:fw)');
  let prelude = [];
  try { prelude = fs.readdirSync(path.join(PROJECT_ROOT, 'src/prelude')).filter((f) => f.endsWith('.js')); } catch { /* none */ }
  out('prelude', prelude.length ? prelude.join(', ') : 'MISSING');

  const { liveState } = await import('../src/injector.mjs');
  const st = liveState();
  if (st && !st.apiPort) {
    out('injector', `pid ${st.injectorPid} (${st.mode}) starting since ${st.startedAt}`);
  } else if (st) {
    out('injector', `pid ${st.injectorPid} (${st.mode}), API 127.0.0.1:${st.apiPort}, CDP ${st.cdpPort}, since ${st.startedAt}`);
    try {
      const r = await apiGet(st, 'app/version');
      out('  API', `app/version -> ${r.status} ${r.text}`);
    } catch (e) {
      out('  API', `unreachable: ${e.message}`);
    }
  } else {
    out('injector', 'not running');
  }

  const plugins = await import('../src/plugins.mjs');
  if (st) {
    // Do not touch plugins_runtime under a running injector; show what it loaded.
    for (const p of plugins.getAllPlugins()) out('  plugin', `${p.slug}${p.dev ? ' (dev)' : ''} ${p.manifest?.version ?? ''}`);
  } else {
    ensureDataDirs();
    const res = plugins.extractPackedPlugins();
    for (const s of res.loaded || []) out('  plugin', `${s}: load`);
    for (const s of res.skipped || []) out('  plugin', `${s.file}: skip (${s.reason})`);
    for (const p of plugins.getAllPlugins().filter((x) => x.dev)) out('  plugin', `${p.slug}: load (dev)`);
    const hijacks = plugins.collectHijacks(getNcmVersion());
    for (const h of hijacks) out('  hijack', `${h.slug}::${h.id} ${h.type} ${h.prefix}`);
    for (const s of plugins.collectStartupScripts()) out('  startup', `${s.slug} (${s.code.length} chars)`);
    // The runtime dir only lives while an injector runs.
    const rt = path.join(dp, 'plugins_runtime');
    for (const n of fs.readdirSync(rt)) fs.rmSync(path.join(rt, n), { recursive: true, force: true });
  }

  console.log('');
  for (const c of checks) console.log(c);
  return checks.some((c) => c.startsWith('FAIL')) ? 1 : 0;
}

function readMacPort() {
  return getMacConfig()['mac.cdpPort'];
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function appPath(values) {
  if (!values.dest && STANDALONE_APP) return STANDALONE_APP;
  // where install-app last wrote it (uninstall from the plugin panel passes no --dest)
  if (!values.dest) {
    try {
      const recorded = fs.readFileSync(appPathMarker(), 'utf8');
      if (recorded && fs.existsSync(recorded) && bundleIdOf(recorded) === WRAPPER_ID) return recorded;
    } catch { /* none */ }
  }
  return path.join(values.dest ? path.resolve(values.dest) : path.join(os.homedir(), 'Applications'), 'BetterNCM.app');
}

// Where the self-contained app was last set up (setup-app); see there.
function appPathMarker() {
  return path.join(getDataPath(), 'app-path');
}

// Borrow NCM's icon (read only) so the Dock entry is recognisable.
function copyNcmIcon(contents) {
  try {
    const iconName = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', path.join(NCM_APP, 'Contents/Info.plist')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const icon = path.join(NCM_APP, 'Contents/Resources', iconName.endsWith('.icns') ? iconName : `${iconName}.icns`);
    fs.copyFileSync(icon, path.join(contents, 'Resources/AppIcon.icns'));
    return true;
  } catch {
    return false; // no icon is fine
  }
}

// Nudge LaunchServices (and so Finder and the Dock) to read the bundle again.
function refreshBundle(app) {
  const now = new Date();
  fs.utimesSync(app, now, now);
  try {
    execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-f', app], { stdio: 'ignore' });
  } catch { /* the touch is usually enough */ }
}

function bundleIdOf(app) {
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// The command that runs this CLI, for the login agent: the self-contained app's own launcher
// (which finds its Node.js wherever the app is), or node and this checkout's CLI.
function launcherArgv() {
  if (STANDALONE_APP) return [path.join(STANDALONE_APP, 'Contents/MacOS/BetterNCM')];
  return [stableNodePath(), path.join(PROJECT_ROOT, 'bin/bncm-mac.mjs')];
}

async function installAgentQuietly() {
  const { installAgent } = await import('../src/agent.mjs');
  try {
    const r = installAgent({ launcher: launcherArgv() });
    console.log(r.changed ? 'installed the login agent' : 'the login agent is installed');
    return true;
  } catch (e) {
    console.log(`could not install the login agent (${e.message})`);
    return false;
  }
}

async function cmdInstallAgent() {
  return (await installAgentQuietly()) ? 0 : 1;
}

async function cmdUninstallAgent() {
  const { uninstallAgent } = await import('../src/agent.mjs');
  console.log(uninstallAgent() ? 'removed the login agent' : 'the login agent is not installed');
  return 0;
}

// Prefer a stable symlink to the running node over the versioned path process.execPath resolves
// to (Homebrew's Cellar/node/<version>, which the next upgrade removes).
function stableNodePath() {
  for (const link of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    try {
      if (fs.realpathSync(link) === fs.realpathSync(process.execPath)) return link;
    } catch { /* not there */ }
  }
  return process.execPath;
}

async function cmdInstallApp(values) {
  if (STANDALONE_APP) fail(`${STANDALONE_APP} is self-contained; install-app is for a source checkout`);
  const app = appPath(values);
  if (fs.existsSync(app)) {
    if (bundleIdOf(app) !== WRAPPER_ID) fail(`${app} exists and is not a BetterNCM wrapper; not touching it`);
    fs.rmSync(app, { recursive: true, force: true });
  }
  const contents = path.join(app, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });

  const tpl = (f) => fs.readFileSync(path.join(PROJECT_ROOT, 'app-wrapper', f), 'utf8');
  // Replacer functions, so a `$` in a path is not read as a replacement pattern.
  fs.writeFileSync(path.join(contents, 'Info.plist'), tpl('Info.plist').replaceAll('{{MAC_VERSION}}', () => MAC_VERSION));
  const script = tpl('BetterNCM.sh')
    .replaceAll('{{NODE}}', () => shellQuote(stableNodePath()))
    .replaceAll('{{CLI}}', () => shellQuote(path.join(PROJECT_ROOT, 'bin/bncm-mac.mjs')));
  // Localized display name, so typing 网易云 in Spotlight or Launchpad finds the wrapper.
  for (const lproj of ['zh-Hans.lproj', 'en.lproj']) {
    fs.mkdirSync(path.join(contents, 'Resources', lproj), { recursive: true });
    fs.copyFileSync(path.join(PROJECT_ROOT, 'app-wrapper', lproj, 'InfoPlist.strings'), path.join(contents, 'Resources', lproj, 'InfoPlist.strings'));
  }
  const exe = path.join(contents, 'MacOS/BetterNCM');
  fs.writeFileSync(exe, script, { mode: 0o755 });
  fs.chmodSync(exe, 0o755);

  copyNcmIcon(contents);

  const now = new Date();
  fs.utimesSync(app, now, now); // nudge LaunchServices to pick up the bundle
  console.log(`installed ${app}`);
  console.log(`node: ${stableNodePath()}`);
  if (values.dock) {
    try {
      console.log(pinToDock(app) ? 'pinned to the Dock' : 'already in the Dock');
    } catch (e) {
      console.log(`could not pin it to the Dock (${e.message}); drag it there yourself`);
    }
  }
  fs.mkdirSync(getDataPath(), { recursive: true });
  fs.writeFileSync(appPathMarker(), app);
  await installAgentQuietly();
  console.log('Open NetEase Cloud Music as usual: the login agent adds BetterNCM.');
  console.log('If this folder moves, run install-app again from the new place.');
  console.log('');
  console.log('Security: while NCM runs this way, any program on this Mac can control it over');
  console.log(`CDP on 127.0.0.1 (port ${readMacPort()}), including the logged-in account and cookies.`);
  console.log('Quit NetEase Cloud Music to close the port.');
  return 0;
}

// BetterNCM.app into the Dock: in NetEase Cloud Music's place when NCM has a tile (it has NCM's
// icon; the way in stays where it was), else at the end.
function placeInDock(app) {
  try {
    if (isPinned(app)) console.log('already in the Dock');
    else if (replaceInDock(NCM_APP, app)) console.log("took NetEase Cloud Music's place in the Dock");
    else console.log(pinToDock(app) ? 'pinned to the Dock' : 'already in the Dock');
  } catch (e) {
    console.log(`could not pin it to the Dock (${e.message})`);
  }
}

// Uninstall: NCM gets its tile back where BetterNCM's was (unless it has one), else the tile goes.
function restoreDock(app) {
  try {
    if (!isPinned(NCM_APP) && replaceInDock(app, NCM_APP)) console.log('put NetEase Cloud Music back in the Dock');
    else unpinQuietly(app);
  } catch { /* a stale Dock icon is harmless */ }
}

// The self-contained app's first run on this Mac (its launcher runs this, and install.sh): NCM's
// icon, which is not ours to ship; the Dock, where BetterNCM.app (with NCM's icon) takes NCM's
// place, so the usual way in opens NCM with BetterNCM and no swap; and the login agent, for NCM
// opened any other way. The app path it was set up at is kept in the data dir: a moved or newly
// installed app is set up again, and a Dock icon the user took away stays away (--dock puts it
// back).
async function cmdSetupApp(values) {
  const app = STANDALONE_APP;
  if (!app) fail('setup-app is for the self-contained BetterNCM.app; in a source checkout, use install-app');
  const contents = path.join(app, 'Contents');
  if (!fs.existsSync(path.join(contents, 'Resources/AppIcon.icns')) && copyNcmIcon(contents)) {
    refreshBundle(app);
    console.log("copied NetEase Cloud Music's icon");
  }
  // every time: the app may have moved, and an update may change the agent
  if (!values['no-agent']) await installAgentQuietly();
  let prev = null;
  try { prev = fs.readFileSync(appPathMarker(), 'utf8'); } catch { /* first time */ }
  if (prev && prev !== app && !fs.existsSync(prev)) unpinQuietly(prev); // moved: the old tile points nowhere
  if (values.dock || (prev !== app && !values['no-dock'])) placeInDock(app);
  if (prev === app) return 0;
  fs.mkdirSync(getDataPath(), { recursive: true });
  fs.writeFileSync(appPathMarker(), app);
  return 0;
}

// The app is gone, so a later install at the same place is set up (and pinned) again.
function forgetAppPath(app) {
  try {
    if (fs.readFileSync(appPathMarker(), 'utf8') === app) fs.rmSync(appPathMarker(), { force: true });
  } catch { /* none */ }
}

async function cmdUninstallApp(values) {
  const app = appPath(values);
  // The self-contained app's injector and agent run from the bundle about to go.
  if (STANDALONE_APP && app === STANDALONE_APP) {
    await cmdUninstallAgent();
    await stopInjector();
  }
  if (!fs.existsSync(app)) {
    console.log(`${app} is not installed`);
    unpinQuietly(app); // a Dock tile can outlive a bundle moved to the Trash
    return 0;
  }
  if (bundleIdOf(app) !== WRAPPER_ID) fail(`${app} is not a BetterNCM wrapper; not removing it`);
  fs.rmSync(app, { recursive: true, force: true });
  console.log(`removed ${app}`);
  restoreDock(app);
  forgetAppPath(app);
  return 0;
}

function unpinQuietly(app) {
  try {
    if (unpinFromDock(app)) console.log('removed it from the Dock');
  } catch { /* a stale Dock icon is harmless */ }
}

// Stops a running injector; fails (removing nothing else) if it will not stop.
async function stopInjector() {
  const { liveState } = await import('../src/injector.mjs');
  const { isPidAlive } = await import('../src/launcher.mjs');
  const st = liveState();
  if (!st) return false;
  console.log(`stopping the injector (pid ${st.injectorPid})`);
  try { process.kill(st.injectorPid, 'SIGTERM'); } catch { /* already gone */ }
  const deadline = Date.now() + 10000;
  while (isPidAlive(st.injectorPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  if (isPidAlive(st.injectorPid)) fail(`the injector (pid ${st.injectorPid}) did not stop; nothing else was changed`);
  return true;
}

// install.sh runs this before it replaces the app: the injector reads its own app's files while
// it runs. NCM keeps running with the debug port; the next launch attaches and reloads the page.
async function cmdStop() {
  if (!(await stopInjector())) console.log('the injector is not running');
  return 0;
}

// After an uninstall: an NCM still running with the debug port is closed and opened again
// without it, so it is the original. -> whether it was reopened.
async function restoreNcm() {
  const { findNcm, quitNcmQuietly } = await import('../src/launcher.mjs');
  const ncm = await findNcm();
  if (!ncm?.port) return false;
  console.log('reopening NetEase Cloud Music without BetterNCM');
  // NCM's CEF has no Browser.close
  if (!(await quitNcmQuietly())) {
    console.log('NetEase Cloud Music did not quit; quit it and open it again yourself');
    return false;
  }
  await new Promise((r) => setTimeout(r, 500));
  try { execFileSync('/usr/bin/open', ['-a', NCM_APP]); } catch { /* the user can open it */ }
  return true;
}

async function cmdUninstall(values) {
  // first the agent, which would otherwise start the injector again
  await cmdUninstallAgent();
  await stopInjector();
  const app = appPath(values);
  const ours = fs.existsSync(app) && bundleIdOf(app) === WRAPPER_ID;
  // The Dock before NCM is reopened: a Dock restarted while NCM is launching saves its old tiles
  // over the new ones as it quits, every time. Restarted now, it holds the new ones itself.
  if (ours) restoreDock(app);
  // before the app goes: this runs from it, and imports what it needs on the way
  const reopened = await restoreNcm();

  if (!fs.existsSync(app)) {
    console.log(`${app} is not installed`);
    unpinQuietly(app);
  }
  else if (!ours) console.log(`${app} is not a BetterNCM wrapper; left alone`);
  else {
    fs.rmSync(app, { recursive: true, force: true });
    console.log(`removed ${app}`);
    forgetAppPath(app);
  }

  if (values.purge) {
    const dp = getDataPath();
    // Only a directory that looks like ours: BETTERNCM_PROFILE could point anywhere.
    const ours = fs.existsSync(path.join(dp, 'plugins')) && fs.existsSync(path.join(dp, 'log'))
      && dp !== os.homedir() && path.dirname(dp) !== dp;
    if (!fs.existsSync(dp)) console.log(`${dp} does not exist`);
    else if (!ours) console.log(`${dp} does not look like a BetterNCM data dir; left alone`);
    else {
      fs.rmSync(dp, { recursive: true, force: true });
      console.log(`deleted ${dp}`);
    }
  }

  console.log('');
  console.log('NetEase Cloud Music itself was never modified.');
  if (!reopened) console.log('If it is running with BetterNCM, quit it and open it again: it then starts without BetterNCM.');
  if (!values.purge) console.log(`Plugins and settings are kept in ${getDataPath()} (uninstall --purge deletes them).`);
  if (!STANDALONE_APP) console.log(`This folder (${PROJECT_ROOT}) can be deleted by hand.`);
  return 0;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      daemon: { type: 'boolean' },
      port: { type: 'string' },
      dest: { type: 'string' },
      purge: { type: 'boolean' },
      dock: { type: 'boolean' },
      'no-dock': { type: 'boolean' },
      agent: { type: 'boolean' },
      'no-agent': { type: 'boolean' },
      replace: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  daemonMode = !!values.daemon;
  if (values.version) {
    console.log(MAC_VERSION);
    return 0;
  }
  const cmd = positionals[0];
  if (!cmd || values.help || cmd === 'help') {
    console.log(USAGE);
    return 0;
  }
  // Check before anything touches NCM: on an old Node, launch would restart NCM with the debug
  // port and only then fail to connect.
  const tooOld = nodeTooOld();
  if (tooOld && ['launch', 'attach', 'reload', 'install-app'].includes(cmd)) {
    await showFatal(tooOld);
    fail(tooOld);
  }
  switch (cmd) {
    case 'launch': return cmdRun('launch', values);
    case 'attach': return cmdRun('attach', values);
    case 'doctor': return cmdDoctor();
    case 'reload': return cmdReload();
    case 'install-app': return cmdInstallApp(values);
    case 'setup-app': return cmdSetupApp(values);
    case 'uninstall-app': return cmdUninstallApp(values);
    case 'stop': return cmdStop();
    case 'uninstall': return cmdUninstall(values);
    case 'install-agent': return cmdInstallAgent();
    case 'uninstall-agent': return cmdUninstallAgent();
    default: fail(`unknown command: ${cmd}\n\n${USAGE}`);
  }
}

// Exit at once: the process is in an unknown state. The dialog runs on its own, once.
let crashed = false;
process.on('uncaughtException', (e) => {
  log('uncaught exception:', e);
  if (daemonMode && !crashed) {
    crashed = true;
    alertDialogDetached(`BetterNCM 出错退出了。\n${e?.message ?? e}\n\n详细日志 / Log: ${path.join(getDataPath(), 'log')}`);
  }
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  log('unhandled rejection:', e);
});

main().then((code) => process.exit(code ?? 0), async (e) => {
  log(e);
  await showFatal(`BetterNCM 启动失败。\n${e?.message ?? e}`);
  process.exit(1);
});
