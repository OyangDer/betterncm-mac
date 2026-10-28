// Thin wrapper around /usr/bin/unzip (Info-ZIP 6.0 ships with macOS).
import { execFileSync, execFile } from 'node:child_process';
import fs, { mkdirSync } from 'node:fs';
import path from 'node:path';

const UNZIP = '/usr/bin/unzip';
const MAX_BUFFER = 512 * 1024 * 1024;

// unzip treats member names as wildcard patterns; escape them so a name only matches itself.
function literalPattern(name) {
  return name.replace(/[[*?]/g, (c) => `[${c}]`);
}

export function listEntries(zip) {
  const out = execFileSync(UNZIP, ['-Z1', zip], { encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
  return out.split('\n').filter((l) => l.length > 0);
}

// Returns the reason an archive is unsafe to extract, or null.
export function checkEntries(zip) {
  for (const name of listEntries(zip)) {
    if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)) return `absolute entry: ${name}`;
    if (name.split(/[\\/]/).includes('..')) return `parent-directory entry: ${name}`;
  }
  // zipinfo's long format starts each member line with its unix mode; 'l' is a symlink,
  // which could point outside the destination, so plugins with symlinks are refused.
  const long = execFileSync(UNZIP, ['-Z', zip], { encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const line of long.split('\n')) {
    if (/^l[rwxsStT-]{9}\s/.test(line)) return `symlink entry: ${line.trim()}`;
  }
  return null;
}

export function readEntry(zip, name) {
  try {
    return execFileSync(UNZIP, ['-p', zip, literalPattern(name)], { maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // unzip -p exits 11 when no member matches
    if (e.status === 11) throw new Error(`${name} not found in ${zip}`);
    throw new Error(`unzip -p failed (${e.status ?? e.code}): ${String(e.stderr || e.message).trim()}`);
  }
}

// Members that came out as symlinks. zipinfo's mode column misses some (e.g. VMS host type,
// which Apple's unzip still turns into links), so look at what was actually written.
// unzip creates symlinks only after all files, so nothing was written through them.
function extractedSymlinks(zip, dest) {
  const found = [];
  for (const name of listEntries(zip)) {
    const segs = name.replace(/\\/g, '/').split('/').filter(Boolean);
    for (let i = 1; i <= segs.length; i++) {
      const p = path.join(dest, ...segs.slice(0, i));
      try {
        if (fs.lstatSync(p).isSymbolicLink()) {
          found.push(p);
          break;
        }
      } catch {
        break;
      }
    }
  }
  return found;
}

// Synchronous full extraction into a fresh `dest`; throws on unsafe archives or unzip errors.
// Exit status 1 is Info-ZIP's "warnings only" (e.g. backslash separators from Windows zippers).
export function extractAll(zip, dest) {
  const bad = checkEntries(zip);
  if (bad) throw new Error(`refusing to extract ${zip}: ${bad}`);
  mkdirSync(dest, { recursive: true });
  try {
    execFileSync(UNZIP, ['-o', '-q', zip, '-d', dest], { maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.status !== 1) throw new Error(`unzip err code:${e.status ?? e.code}: ${String(e.stderr || '').trim()}`);
  }
  const links = extractedSymlinks(zip, dest);
  if (links.length) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw new Error(`refusing to extract ${zip}: symlink entry: ${path.relative(dest, links[0])}`);
  }
}

// Async variant used by the fs.unzip APIs: resolves to unzip's exit code (0 = OK, warnings included).
// Unsafe archives resolve to -1 without extracting anything (symlink members are removed again).
export function extractAllAsync(zip, dest) {
  return new Promise((resolve) => {
    let bad;
    try {
      bad = checkEntries(zip);
    } catch (e) {
      resolve(typeof e.status === 'number' ? e.status : -1);
      return;
    }
    if (bad) {
      resolve(-1);
      return;
    }
    try {
      mkdirSync(dest, { recursive: true });
    } catch {
      resolve(-1);
      return;
    }
    execFile(UNZIP, ['-o', '-q', zip, '-d', dest], { maxBuffer: MAX_BUFFER }, (err) => {
      if (err && err.code !== 1) {
        resolve(typeof err.code === 'number' ? err.code : -1);
        return;
      }
      // dest may hold other files: only the symlinks this archive produced are removed.
      let links;
      try {
        links = extractedSymlinks(zip, dest);
      } catch {
        links = [];
      }
      for (const l of links) fs.rmSync(l, { force: true });
      resolve(links.length ? -1 : 0);
    });
  });
}
