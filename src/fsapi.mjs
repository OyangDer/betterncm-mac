// File-system half of the native API (v8NativeCalls.cpp / App.cpp fs routes) on macOS paths.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDataPath, readConfigKey, NCM_APP } from './config.mjs';
import { extractAllAsync, listEntries } from './zip.mjs';

// ms between 1601-01-01 (Windows FILETIME epoch, what v2's std::filesystem clock used) and 1970-01-01.
// PluginMarket's remover.js subtracts it again.
export const FILETIME_OFFSET_MS = 11644473600000;

// DESIGN.md section 1.5: the macOS counterpart of v2's `path[1] != ':'` rule.
export function resolve(p) {
  p = String(p ?? '').replace(/\\/g, '/');
  const dp = getDataPath();
  if (p.startsWith(dp)) return p;
  if (/^[A-Za-z]:/.test(p)) throw new Error('Windows path not supported');
  if (p.startsWith('/')) {
    const seg = p.split('/')[1];
    if (seg && fs.existsSync('/' + seg)) return p;
    return dp + p;
  }
  // deliberately not normalized: "./plugins_dev" must stay visible in returned paths
  return dp + '/' + p;
}

// The path the kernel will actually touch: walks the segments left to right, follows every
// existing symlink (dangling ones too) and applies '..' to the resolved directory, never as text.
// With followLast=false a final symlink is the object itself (rm/rename act on the link).
function physicalPath(abs, followLast = true) {
  const todo = String(abs).split('/').reverse();
  let cur = '/';
  let links = 0;
  while (todo.length) {
    const seg = todo.pop();
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      cur = path.dirname(cur);
      continue;
    }
    const next = cur === '/' ? '/' + seg : cur + '/' + seg;
    let st = null;
    try {
      st = fs.lstatSync(next);
    } catch {
      // does not exist (yet): taken literally
    }
    const isLast = !todo.some((x) => x !== '' && x !== '.');
    if (st?.isSymbolicLink() && (followLast || !isLast)) {
      if (++links > 40) throw Object.assign(new Error(`too many symlinks in ${abs}`), { code: 'ELOOP' });
      const target = fs.readlinkSync(next);
      if (target.startsWith('/')) cur = '/';
      todo.push(...target.split('/').reverse());
      continue;
    }
    cur = next;
  }
  return cur;
}

function within(p, root) {
  return p === root || p.startsWith(root + '/');
}

export function isInsideDataPath(abs) {
  return within(physicalPath(abs), physicalPath(getDataPath()));
}

function denied(msg) {
  const e = new Error(msg);
  e.code = 'EBNCMDENIED';
  return e;
}

// Mutating operations stay inside the data dir unless mac.allowFsOutsideData is on. The NCM app,
// config.json (it holds the exec/fs policy) and run/ are off limits either way.
// Returns the physical path, which is what the caller must operate on.
function guardWrite(abs, what, followLast = true) {
  const phys = physicalPath(abs, followLast);
  const root = physicalPath(getDataPath());
  const rel = within(phys, root) ? phys.slice(root.length + 1) : null;
  // APFS is case-insensitive by default, so the hard denials compare in lower case.
  const lc = (x) => x.toLowerCase();
  if (within(lc(phys), lc(physicalPath(NCM_APP)))) throw denied(`${what} inside ${NCM_APP} is never allowed: ${abs}`);
  if (rel != null && (/^config\.json/i.test(rel) || within(lc(rel), 'run'))) throw denied(`${what} ${rel} through the fs API is not allowed: ${abs}`);
  if (rel == null && readConfigKey('mac.allowFsOutsideData', 'false') !== 'true') {
    throw denied(`${what} outside the BetterNCM data directory is not allowed (set mac.allowFsOutsideData=true): ${abs}`);
  }
  return phys;
}

function joinChild(dir, name) {
  return dir.endsWith('/') ? dir + name : dir + '/' + name;
}

function statOf(p) {
  try {
    return fs.statSync(p);
  } catch {
    return fs.lstatSync(p); // dangling symlink
  }
}

function typeOf(st) {
  if (st.isDirectory()) return 'directory';
  if (st.isFile()) return 'file';
  if (st.isSymbolicLink()) return 'symlink';
  return 'unknown';
}

function details(p, name, st) {
  return {
    path: p,
    name,
    extension: path.extname(name),
    type: typeOf(st),
    size: st.isDirectory() ? 0 : st.size,
    lastModified: Math.floor(st.mtimeMs) + FILETIME_OFFSET_MS,
    hidden: name.startsWith('.'),
    system: false,
  };
}

export function readDir(p) {
  const dir = resolve(p);
  return fs.readdirSync(dir).map((name) => joinChild(dir, name));
}

export function readDirWithDetails(p) {
  const dir = resolve(p);
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const child = joinChild(dir, name);
    try {
      out.push(details(child, name, statOf(child)));
    } catch {
      // vanished between readdir and stat
    }
  }
  return out;
}

// Like v2's ifstream read: anything unreadable yields "".
export function readFileText(p) {
  try {
    return fs.readFileSync(resolve(p), 'utf8');
  } catch {
    return '';
  }
}

export function readFileBuffer(p) {
  try {
    return fs.readFileSync(resolve(p));
  } catch {
    return Buffer.alloc(0);
  }
}

export function exists(p) {
  try {
    return fs.existsSync(resolve(p));
  } catch {
    return false;
  }
}

export function getProperties(p) {
  const abs = resolve(p);
  const st = statOf(abs);
  const name = path.basename(abs);
  const d = details(abs, name, st);
  d.path = path.dirname(abs); // v2 returns the parent directory here
  return d;
}

export function writeFileText(p, text) {
  return writeFileBuffer(p, Buffer.from(String(text), 'utf8'));
}

export function writeFileBuffer(p, buf) {
  const phys = guardWrite(resolve(p), 'Writing');
  fs.mkdirSync(path.dirname(phys), { recursive: true });
  fs.writeFileSync(phys, buf);
  return true;
}

export function remove(p) {
  const abs = resolve(p);
  const phys = guardWrite(abs, 'Removing', false);
  const root = physicalPath(getDataPath());
  if (phys === root || physicalPath(abs) === root) throw new Error('Refusing to remove the BetterNCM data directory itself');
  fs.rmSync(phys, { recursive: true, force: true });
  return true;
}

export function rename(a, b) {
  const src = guardWrite(resolve(a), 'Renaming', false);
  const dest = guardWrite(resolve(b), 'Renaming', false);
  fs.renameSync(src, dest);
  return true;
}

export function mkdir(p) {
  const phys = guardWrite(resolve(p), 'Creating directories');
  fs.mkdirSync(phys, { recursive: true });
  return true;
}

export async function unzip(zip, dest) {
  const src = resolve(zip);
  const out = guardWrite(resolve(dest), 'Extracting');
  // Every member must pass the guard too (e.g. a config.json member extracted into the data dir root).
  let names;
  try {
    names = listEntries(src);
  } catch (e) {
    return typeof e.status === 'number' ? e.status : -1;
  }
  for (const name of names) guardWrite(path.join(out, name.replace(/\\/g, '/')), 'Extracting');
  return extractAllAsync(src, out);
}

// Recursive FSEvents watch; onEvent(dir, relFilename) is debounced per file.
export function watchDirectory(p, onEvent) {
  const dir = resolve(p);
  const timers = new Map();
  const watcher = fs.watch(dir, { recursive: true }, (_evt, filename) => {
    if (filename == null) return;
    const rel = String(filename);
    clearTimeout(timers.get(rel));
    timers.set(rel, setTimeout(() => {
      timers.delete(rel);
      try {
        onEvent(dir, rel);
      } catch {
        // a broken callback must not kill the watcher
      }
    }, 50));
  });
  watcher.on('error', () => {});
  let disposed = false;
  return function dispose() {
    if (disposed) return;
    disposed = true;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    watcher.close();
  };
}

export function getDisks() {
  const disks = [];
  let names = [];
  try {
    names = fs.readdirSync('/Volumes');
  } catch {
    return disks;
  }
  for (const name of names) {
    const disk = '/Volumes/' + name;
    try {
      const s = fs.statfsSync(disk);
      disks.push({ disk, name, used: (s.blocks - s.bfree) * s.bsize, size: s.blocks * s.bsize });
    } catch {
      // unreadable or vanished volume
    }
  }
  return disks;
}

export function getLibraries() {
  const home = os.homedir();
  const libs = [
    ['Desktop', 'Desktop'],
    ['Downloads', 'Downloads'],
    ['Documents', 'Documents'],
    ['Pictures', 'Pictures'],
    ['Music', 'Music'],
    ['Videos', 'Movies'],
  ];
  return libs
    .map(([name, dir]) => ({ name, path: path.join(home, dir) }))
    .filter((l) => fs.existsSync(l.path));
}

// v2's table (utils.cpp:186-197) plus common web types.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.flac': 'audio/mpeg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

export function mimeOf(p) {
  return MIME[path.extname(String(p)).toLowerCase()] || 'application/octet-stream';
}
