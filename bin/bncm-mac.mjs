#!/usr/bin/env node
// betterncm-mac command line. Modules that need the other parts of the project are
// imported lazily, so `help` and `install-app` work on a partial checkout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  NCM_APP, BNCM_VERSION, MAC_VERSION, PROJECT_ROOT, getDataPath, ensureDataDirs, getNcmVersion, getNcmBuild,
  getMacConfig, isSafeMode,
} from '../src/config.mjs';
import { log, setQuiet } from '../src/log.mjs';

const WRAPPER_ID = 'cc.microblock.betterncm-mac';

const USAGE = `betterncm-mac ${MAC_VERSION} - BetterNCM for NetEase Cloud Music on macOS (via CDP)

Usage: bncm-mac <command> [options]

  launch [--daemon] [--port N]   find or launch NCM with the debug port, inject, stay running
  attach [--port N]              attach to an NCM that already has a debug port; never launches or quits it
  doctor                         print versions, ports, targets, data dir and plugin decisions
  reload                         re-extract plugins in the running injector and reload the pages
  install-app [--dest DIR]       write BetterNCM.app (default ~/Applications)
  uninstall-app [--dest DIR]     remove BetterNCM.app

Data dir: ${getDataPath()} (override with BETTERNCM_PROFILE)

Security: while NCM runs with --remote-debugging-port, any local process can control it over
CDP on 127.0.0.1, including the logged-in account and cookies.`;

function fail(msg) {
  process.stderr.write(`bncm-mac: ${msg}\n`);
  process.exit(1);
}

function portArg(v) {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`invalid port: ${v}`);
  return n;
}

async function cmdRun(mode, values) {
  if (values.daemon) setQuiet(true);
  const { runInjector, liveState } = await import('../src/injector.mjs');
  const { findNcm } = await import('../src/launcher.mjs');
  let res = await runInjector({ mode, port: portArg(values.port) });
  if (res.alreadyRunning && mode === 'launch') {
    // Opening the wrapper twice should just bring NCM to the front, but only an NCM that has
    // the debug port: the other injector may be winding down (NCM quitting) or restarting it,
    // and `open -a` would start NCM without the port. Wait for it to finish instead.
    const deadline = Date.now() + 15000;
    for (;;) {
      if ((await findNcm())?.port && liveState()) {
        try { execFileSync('/usr/bin/open', ['-a', NCM_APP]); } catch { /* ignore */ }
        return 0;
      }
      if (!liveState()) {
        res = await runInjector({ mode, port: portArg(values.port) });
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

async function cmdDoctor() {
  const out = (k, v) => console.log(`${k.padEnd(14)} ${v}`);
  out('betterncm-mac', `${MAC_VERSION} (reports BetterNCM ${BNCM_VERSION}), node ${process.version}`);
  out('project', PROJECT_ROOT);

  const hasApp = fs.existsSync(NCM_APP);
  out('NCM app', hasApp ? `${NCM_APP} ${getNcmVersion()} (build ${getNcmBuild()})` : `${NCM_APP} NOT FOUND`);

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
  return 0;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function appPath(values) {
  return path.join(values.dest ? path.resolve(values.dest) : path.join(os.homedir(), 'Applications'), 'BetterNCM.app');
}

function bundleIdOf(app) {
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function cmdInstallApp(values) {
  const app = appPath(values);
  if (fs.existsSync(app)) {
    if (bundleIdOf(app) !== WRAPPER_ID) fail(`${app} exists and is not a BetterNCM wrapper; not touching it`);
    fs.rmSync(app, { recursive: true, force: true });
  }
  const contents = path.join(app, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });

  const tpl = (f) => fs.readFileSync(path.join(PROJECT_ROOT, 'app-wrapper', f), 'utf8');
  fs.writeFileSync(path.join(contents, 'Info.plist'), tpl('Info.plist').replaceAll('{{MAC_VERSION}}', MAC_VERSION));
  const script = tpl('BetterNCM.sh')
    .replaceAll('{{NODE}}', shellQuote(process.execPath))
    .replaceAll('{{CLI}}', shellQuote(path.join(PROJECT_ROOT, 'bin/bncm-mac.mjs')));
  const exe = path.join(contents, 'MacOS/BetterNCM');
  fs.writeFileSync(exe, script, { mode: 0o755 });
  fs.chmodSync(exe, 0o755);

  // Borrow NCM's icon (read only) so the Dock entry is recognisable.
  try {
    const iconName = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', path.join(NCM_APP, 'Contents/Info.plist')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const icon = path.join(NCM_APP, 'Contents/Resources', iconName.endsWith('.icns') ? iconName : `${iconName}.icns`);
    fs.copyFileSync(icon, path.join(contents, 'Resources/AppIcon.icns'));
  } catch { /* no icon is fine */ }

  const now = new Date();
  fs.utimesSync(app, now, now); // nudge LaunchServices to pick up the bundle
  console.log(`installed ${app}`);
  console.log(`node: ${process.execPath}`);
  console.log('Open BetterNCM.app instead of NetEase Cloud Music (keep it in the Dock).');
  console.log('If node moves (e.g. a version manager upgrade), run install-app again.');
  return 0;
}

function cmdUninstallApp(values) {
  const app = appPath(values);
  if (!fs.existsSync(app)) {
    console.log(`${app} is not installed`);
    return 0;
  }
  if (bundleIdOf(app) !== WRAPPER_ID) fail(`${app} is not a BetterNCM wrapper; not removing it`);
  fs.rmSync(app, { recursive: true, force: true });
  console.log(`removed ${app}`);
  return 0;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      daemon: { type: 'boolean' },
      port: { type: 'string' },
      dest: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.version) {
    console.log(MAC_VERSION);
    return 0;
  }
  const cmd = positionals[0];
  if (!cmd || values.help || cmd === 'help') {
    console.log(USAGE);
    return 0;
  }
  switch (cmd) {
    case 'launch': return cmdRun('launch', values);
    case 'attach': return cmdRun('attach', values);
    case 'doctor': return cmdDoctor();
    case 'reload': return cmdReload();
    case 'install-app': return cmdInstallApp(values);
    case 'uninstall-app': return cmdUninstallApp(values);
    default: fail(`unknown command: ${cmd}\n\n${USAGE}`);
  }
}

process.on('uncaughtException', (e) => {
  log('uncaught exception:', e);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  log('unhandled rejection:', e);
});

main().then((code) => process.exit(code ?? 0), (e) => {
  log(e);
  process.exit(1);
});
