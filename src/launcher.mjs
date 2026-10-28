// Finds, quits and launches NetEase Cloud Music with the CDP port. Never sends SIGKILL.
import fs from 'node:fs';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NCM_APP, BUNDLE_ID } from './config.mjs';
import { fetchVersion, fetchTargets } from './cdp.mjs';
import { alertDialog, confirmDialog } from './dialog.mjs';
import { log } from './log.mjs';

export { alertDialog, confirmDialog };

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NCM_PROCESS = 'NeteaseMusic';

async function run(cmd, args, opts = {}) {
  try {
    const { stdout } = await execFileP(cmd, args, { encoding: 'utf8', ...opts });
    return { code: 0, stdout };
  } catch (e) {
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout || '', stderr: e.stderr || String(e.message) };
  }
}

export function parseDebugPort(args) {
  const m = /--remote-debugging-port=(\d+)/.exec(args || '');
  return m ? Number(m[1]) : null;
}

// -> {pid, port|null, args} for the main NCM process, or null.
export async function findNcm() {
  const r = await run('/usr/bin/pgrep', ['-x', NCM_PROCESS]);
  if (r.code !== 0) return null;
  const pids = r.stdout.split('\n').map(Number).filter(Boolean).sort((a, b) => a - b);
  for (const pid of pids) {
    const a = await run('/bin/ps', ['-o', 'args=', '-p', String(pid)]);
    if (a.code !== 0) continue;
    const args = a.stdout.trim();
    return { pid, port: parseDebugPort(args), args };
  }
  return null;
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function tryListen(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(null));
    srv.listen(port, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// The preferred port if it is free, otherwise a random free one.
export async function pickPort(preferred) {
  if (preferred && (await tryListen(preferred))) return preferred;
  const p = await tryListen(0);
  if (!p) throw new Error('no free port on 127.0.0.1');
  if (preferred) log(`port ${preferred} is busy, using ${p} for CDP`);
  return p;
}

// An error the user has already been shown in a dialog; callers must not show another one.
export function shownError(message) {
  return Object.assign(new Error(message), { alerted: true });
}

// Graceful quit through Apple Events, then wait for the process to go away.
export async function quitNcm({ timeout = 15000 } = {}) {
  const before = await findNcm();
  if (!before) return true;
  log(`asking NCM (pid ${before.pid}) to quit`);
  const r = await run('/usr/bin/osascript', ['-e', `tell application id "${BUNDLE_ID}" to quit`]);
  if (r.code !== 0) log('quit via AppleScript failed:', (r.stderr || '').trim());
  // -1743: the user denied (or never answered) the Automation prompt; waiting will not help.
  if (r.code !== 0 && /-1743|not authori[sz]ed/i.test(r.stderr || '')) {
    await alertDialog(
      'BetterNCM 没有控制网易云音乐的权限，无法让它退出。\n'
      + '请到“系统设置 → 隐私与安全性 → 自动化”，在 BetterNCM（或你用的终端）下面打开“网易云音乐”，然后重新打开 BetterNCM。\n\n'
      + 'BetterNCM is not allowed to control NetEase Cloud Music. Allow it in System Settings → Privacy & Security → Automation, then open BetterNCM again.',
    );
    throw shownError('not allowed to send Apple events to NCM (Automation permission)');
  }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!isPidAlive(before.pid) && !(await findNcm())) return true;
    await sleep(250);
  }
  log(`NCM did not quit within ${timeout} ms`);
  return false;
}

export async function launchNcm(port) {
  if (!fs.existsSync(NCM_APP)) throw new Error(`${NCM_APP} not found`);
  const args = ['-a', NCM_APP, '--args', `--remote-debugging-port=${port}`, `--remote-allow-origins=http://127.0.0.1:${port}`];
  log('launching NCM:', 'open', args.join(' '));
  const r = await run('/usr/bin/open', args);
  if (r.code !== 0) throw new Error(`open failed: ${(r.stderr || '').trim()}`);
}

// Polls /json/version every 100 ms.
export async function waitForCdp(port, { timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return await fetchVersion(port, { timeout: 1000 });
    } catch (e) {
      lastErr = e;
    }
    await sleep(100);
  }
  throw new Error(`CDP on port ${port} not reachable after ${timeout} ms (${lastErr?.message})`);
}

// The endpoint must be NetEase itself: attaching to some other Chromium on the port would hand
// its pages the injection (and the API key).
async function verifyNcm(port, version) {
  if (String(version?.['User-Agent'] ?? '').includes('NeteaseMusicDesktop')) return;
  try {
    if ((await fetchTargets(port)).some((t) => t.type === 'page' && String(t.url).startsWith('orpheus://'))) return;
  } catch { /* fall through */ }
  throw new Error(`CDP on port ${port} is not NetEase Cloud Music (${version?.Browser ?? 'unknown browser'}); not attaching`);
}

async function waitForNcmPid(timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const n = await findNcm();
    if (n) return n;
    await sleep(200);
  }
  return null;
}

async function startFresh(preferredPort) {
  const port = await pickPort(preferredPort);
  await launchNcm(port);
  await verifyNcm(port, await waitForCdp(port));
  const n = await waitForNcmPid();
  return { pid: n?.pid ?? null, port, launched: true };
}

// Makes sure NCM runs with a CDP port. With launch=false only attaches to what is there.
// -> {pid, port, launched}
export async function ensureNcm({ preferredPort = 9222, launch = true, port = null } = {}) {
  const running = await findNcm();

  if (!launch) {
    // Without an explicit port only NCM's own command line says where to attach.
    const p = port || running?.port;
    if (!p) throw new Error(running ? 'NCM is running without a debug port' : 'NCM is not running');
    await verifyNcm(p, await waitForCdp(p, { timeout: 5000 }));
    return { pid: running?.pid ?? null, port: p, launched: false };
  }

  if (running?.port) {
    log(`NCM is running (pid ${running.pid}) with CDP port ${running.port}`);
    await verifyNcm(running.port, await waitForCdp(running.port));
    return { pid: running.pid, port: running.port, launched: false };
  }

  if (running) {
    const yes = await confirmDialog(
      '网易云音乐正在运行，但没有加载 BetterNCM。要退出并用 BetterNCM 重新打开吗？\n\n'
      + 'NetEase Cloud Music is running without BetterNCM. Quit and restart it with BetterNCM?',
      { ok: '重新打开 Restart', cancel: '取消 Cancel' },
    );
    if (!yes) {
      throw Object.assign(new Error('NCM is running without the debug port and the user declined a restart'), { userCancelled: true });
    }
    if (!(await quitNcm())) {
      await alertDialog('网易云音乐没有退出。请手动退出它，然后重新打开 BetterNCM。\n\n'
        + 'NetEase Cloud Music did not quit. Quit it yourself, then open BetterNCM again.');
      throw shownError('NCM did not quit');
    }
  }

  return startFresh(port || preferredPort);
}

// Used by app.restart: graceful quit, then relaunch with the same port.
export async function restartNcm(port) {
  if (!(await quitNcm())) throw new Error('NCM did not quit; not relaunching');
  await sleep(300);
  await launchNcm(port);
  await verifyNcm(port, await waitForCdp(port));
  const n = await waitForNcmPid();
  return { pid: n?.pid ?? null, port, launched: true };
}
