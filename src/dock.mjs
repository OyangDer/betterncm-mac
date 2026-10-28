// Pins the wrapper app to the Dock and takes it off again, through the Dock's preferences
// (persistent-apps) and a Dock restart. `domain` is only overridden by the tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DOCK = 'com.apple.dock';

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

// The Dock stores app tiles as file URLs with a trailing slash.
function tileUrl(app) {
  return pathToFileURL(path.resolve(app)).href.replace(/\/?$/, '/');
}

// Works on an exported copy of the domain, so data values in it survive untouched.
function withExport(domain, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncm-dock-'));
  const file = path.join(dir, 'dock.plist');
  try {
    sh('/usr/bin/defaults', ['export', domain, file]);
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function tileUrls(file) {
  const urls = [];
  for (let i = 0; ; i++) {
    try {
      sh('/usr/bin/plutil', ['-extract', `persistent-apps.${i}`, 'xml1', '-o', '-', file]);
    } catch {
      return urls; // past the end (or no persistent-apps at all)
    }
    try {
      urls.push(sh('/usr/bin/plutil', ['-extract', `persistent-apps.${i}.tile-data.file-data._CFURLString`, 'raw', '-o', '-', file]).trim());
    } catch {
      urls.push(null); // a tile without a file URL
    }
  }
}

export function isPinned(app, { domain = DOCK } = {}) {
  const url = tileUrl(app);
  return withExport(domain, (file) => tileUrls(file).includes(url));
}

function restartDock(domain) {
  if (domain !== DOCK) return;
  try { sh('/usr/bin/killall', ['Dock']); } catch { /* the Dock picks it up on its next start */ }
}

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Adds the app at the end of the Dock's app section. -> false when it was already there.
export function pinToDock(app, { domain = DOCK } = {}) {
  if (isPinned(app, { domain })) return false;
  const tile = '<dict><key>tile-data</key><dict><key>file-data</key><dict>'
    + `<key>_CFURLString</key><string>${xmlEscape(tileUrl(app))}</string>`
    + '<key>_CFURLStringType</key><integer>15</integer></dict></dict>'
    + '<key>tile-type</key><string>file-tile</string></dict>';
  sh('/usr/bin/defaults', ['write', domain, 'persistent-apps', '-array-add', tile]);
  restartDock(domain);
  return true;
}

// Removes every tile for the app. -> false when there was none.
export function unpinFromDock(app, { domain = DOCK } = {}) {
  const url = tileUrl(app);
  return withExport(domain, (file) => {
    const urls = tileUrls(file);
    const hits = urls.map((u, i) => (u === url ? i : -1)).filter((i) => i >= 0).reverse();
    if (!hits.length) return false;
    for (const i of hits) sh('/usr/bin/plutil', ['-remove', `persistent-apps.${i}`, file]);
    sh('/usr/bin/defaults', ['import', domain, file]);
    restartDock(domain);
    return true;
  });
}
