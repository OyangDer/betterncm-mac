// macOS replacements for v2's Win32 calls (ShellExecute, registry theme, GetOpenFileName, F12 DevTools).
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.mjs';
import { resolve as resolveFsPath } from './fsapi.mjs';

function run(cmd, args, opts = {}) {
  return new Promise((res) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 0, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      res({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

// Command lines come from Windows-minded plugins, so split them the way CommandLineToArgvW does:
// whitespace separates, "..." groups, backslashes are literal unless they precede a quote.
export function splitCommandLine(s) {
  const argv = [];
  let cur = '';
  let inArg = false;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      let n = 0;
      while (s[i] === '\\') {
        n++;
        i++;
      }
      if (s[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2) cur += '"';
        else quoted = !quoted;
      } else {
        cur += '\\'.repeat(n);
        i--;
      }
      inArg = true;
    } else if (c === '"') {
      quoted = !quoted;
      inArg = true;
    } else if (!quoted && /\s/.test(c)) {
      if (inArg) argv.push(cur);
      cur = '';
      inArg = false;
    } else {
      cur += c;
      inArg = true;
    }
  }
  if (inArg) argv.push(cur);
  return argv;
}

function isWebUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Plain folders are opened in Finder. Files and bundle-like folders (Foo.app, x.pkg, ...) are only
// revealed, because `open` on them would launch code.
export async function openTarget(urlOrPath) {
  if (isWebUrl(urlOrPath)) {
    const r = await run('/usr/bin/open', [urlOrPath]);
    return !r.err;
  }
  // Decide on the real path, so a symlink or a "Foo.app/.." spelling cannot pass for a plain folder.
  let real;
  let st;
  try {
    real = fs.realpathSync(String(urlOrPath));
    st = fs.statSync(real);
  } catch {
    return false;
  }
  const plainDir = st.isDirectory() && path.extname(real) === '';
  const r = await run('/usr/bin/open', plainDir ? [real] : ['-R', real]);
  return !r.err;
}

function existingPath(p) {
  if (!p) return null;
  try {
    const abs = resolveFsPath(p);
    return fs.existsSync(abs) ? abs : null;
  } catch {
    return null;
  }
}

// DESIGN.md 2b policy for POST /api/app/exec. Resolves to {status, message}.
export async function execCommand(cmdline, cfg = {}) {
  const argv = splitCommandLine(String(cmdline ?? '').trim());
  if (argv.length === 0) return { status: 400, message: 'empty command' };
  const [cmd, ...rest] = argv;

  if (isWebUrl(cmd)) {
    log('[exec] open url', cmd);
    await openTarget(cmd);
    return { status: 200, message: 'ok' };
  }
  if (/^explorer(\.exe)?$/i.test(cmd)) {
    const target = existingPath(rest.find((a) => !a.startsWith('/select')) ?? '');
    if (!target) return { status: 404, message: 'path not found' };
    log('[exec] explorer ->', target);
    await openTarget(target);
    return { status: 200, message: 'ok' };
  }
  const asPath = existingPath(cmd);
  if (asPath && rest.length === 0) {
    log('[exec] open path', asPath);
    await openTarget(asPath);
    return { status: 200, message: 'ok' };
  }
  if (cfg['mac.allowExec'] === 'true') {
    log('[exec] running', JSON.stringify(argv));
    try {
      const child = spawn(cmd, rest, { detached: true, stdio: 'ignore' });
      child.on('error', (e) => log('[exec] failed:', e.message));
      child.unref();
    } catch (e) {
      return { status: 500, message: e.message };
    }
    return { status: 200, message: 'ok' };
  }
  log('[exec] refused', JSON.stringify(cmdline));
  return { status: 403, message: 'exec is disabled on macOS (set mac.allowExec=true to allow arbitrary commands)' };
}

export async function isLightTheme() {
  const r = await run('/usr/bin/defaults', ['read', '-g', 'AppleInterfaceStyle'], { timeout: 5000 });
  if (r.err) return true;
  return r.stdout.trim() !== 'Dark';
}

function asString(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Extracts extensions from Win32-style ("Images\0*.png;*.jpg\0") or loose (".png .jpg") filters.
export function filterExtensions(filter) {
  const f = String(filter ?? '');
  if (/\*\.\*|(^|[\s;\0])\*($|[\s;\0])/.test(f)) return [];
  const exts = new Set();
  for (const m of f.matchAll(/\.([A-Za-z0-9]+)/g)) exts.add(m[1].toLowerCase());
  return [...exts];
}

// Resolves to the chosen POSIX path, or "" on cancel.
export async function openFileDialog(filter, initialDir) {
  const exts = filterExtensions(filter);
  let cmd = 'choose file';
  const dir = existingPath(initialDir);
  if (dir) {
    try {
      if (fs.statSync(dir).isDirectory()) cmd += ` default location POSIX file ${asString(path.resolve(dir))}`;
    } catch {
      // ignore
    }
  }
  if (exts.length) cmd += ` of type {${exts.map(asString).join(', ')}}`;
  const r = await run('/usr/bin/osascript', ['-e', 'activate', '-e', `POSIX path of (${cmd})`]);
  if (r.err) {
    if (!/-128/.test(r.stderr)) log('[dialog] osascript failed:', r.stderr.trim() || r.err.message);
    return '';
  }
  return r.stdout.replace(/\n$/, '');
}

// Opens CEF's DevTools frontend for one page target in the default browser.
export async function openDevtools(port, targetId) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(targetId)) || !Number.isInteger(Number(port))) return false;
  const url = `http://127.0.0.1:${port}/devtools/inspector.html?ws=127.0.0.1:${port}/devtools/page/${targetId}`;
  log('[devtools] open', url);
  const r = await run('/usr/bin/open', [url]);
  return !r.err;
}
