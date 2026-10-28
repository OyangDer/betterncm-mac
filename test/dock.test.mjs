// src/dock.mjs against a throwaway defaults domain shaped like com.apple.dock (no Dock restart).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isPinned, pinToDock, unpinFromDock } from '../src/dock.mjs';

const domain = `cc.microblock.betterncm-mac.test-dock-${process.pid}`;
const APP = '/Users/someone/Applications/BetterNCM.app';
const OTHER = '<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key>'
  + '<string>file:///System/Applications/Mail.app/</string><key>_CFURLStringType</key><integer>15</integer>'
  + '</dict><key>file-label</key><string>Mail</string></dict><key>tile-type</key><string>file-tile</string></dict>';
const defaults = (...a) => execFileSync('/usr/bin/defaults', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

before(() => defaults('write', domain, 'persistent-apps', '-array', OTHER));
// `defaults delete` empties the domain but leaves its file behind.
after(() => {
  try { defaults('delete', domain); } catch { /* gone */ }
  fs.rmSync(path.join(os.homedir(), 'Library/Preferences', `${domain}.plist`), { force: true });
});

test('pins once, keeps other tiles, and unpins', () => {
  assert.equal(isPinned(APP, { domain }), false);
  assert.equal(pinToDock(APP, { domain }), true);
  assert.equal(isPinned(APP, { domain }), true);
  assert.equal(pinToDock(APP, { domain }), false, 'second pin is a no-op');
  assert.match(defaults('read', domain, 'persistent-apps'), /Mail\.app/);
  assert.equal(unpinFromDock(APP, { domain }), true);
  assert.equal(isPinned(APP, { domain }), false);
  assert.match(defaults('read', domain, 'persistent-apps'), /Mail\.app/);
  assert.equal(unpinFromDock(APP, { domain }), false);
});

test('a path with spaces is stored percent-encoded and still matched', () => {
  const spaced = '/Users/some one/Applications/BetterNCM.app';
  pinToDock(spaced, { domain });
  assert.match(defaults('read', domain, 'persistent-apps'), /some%20one/);
  assert.equal(isPinned(spaced, { domain }), true);
  assert.equal(unpinFromDock(spaced, { domain }), true);
});
