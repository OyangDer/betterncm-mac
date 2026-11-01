// The self-contained BetterNCM.app (scripts/build-app.mjs) and the one-line installer (install.sh):
// the bundle's layout, its launcher running the bundled CLI, and the installer's Node pins.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../scripts/build-app.mjs';
import { MAC_VERSION, standaloneApp } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bncm-app-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A stand-in for the bundled Node binary: the Node running the tests.
function stubNode(dir) {
  const stub = path.join(dir, 'node');
  fs.writeFileSync(stub, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  return stub;
}

test('standaloneApp: only a project in <name>.app/Contents/Resources/app', () => {
  assert.equal(standaloneApp('/Applications/BetterNCM.app/Contents/Resources/app'), '/Applications/BetterNCM.app');
  assert.equal(standaloneApp('/Users/me/betterncm-mac'), null);
  assert.equal(standaloneApp('/x/Folder/Contents/Resources/app'), null);
  assert.equal(standaloneApp('/x/BetterNCM.app/Contents/Resources/other'), null);
});

test('the built app holds the project and Node, and its launcher runs the bundled CLI', () => {
  withTmp((dir) => {
    const app = path.join(dir, 'BetterNCM.app');
    buildApp({ node: stubNode(dir), out: app });
    const res = path.join(app, 'Contents/Resources');
    for (const f of ['bin/bncm-mac.mjs', 'src/config.mjs', 'src/prelude', 'dist/framework.js', 'resources/PluginMarket.plugin', 'vendor/semver', 'package.json', 'LICENSE']) {
      assert.ok(fs.existsSync(path.join(res, 'app', f)), `app/${f}`);
    }
    for (const f of ['test', 'framework', 'install.sh', 'app-wrapper']) assert.ok(!fs.existsSync(path.join(res, 'app', f)), `no app/${f}`);
    assert.ok(fs.statSync(path.join(res, 'node/bin/node')).mode & 0o111);
    assert.ok(fs.existsSync(path.join(res, 'zh-Hans.lproj/InfoPlist.strings')));
    const plist = fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8');
    assert.match(plist, new RegExp(`<string>${MAC_VERSION.replaceAll('.', '\\.')}</string>`));
    assert.match(plist, /cc\.microblock\.betterncm-mac/);

    const exe = path.join(app, 'Contents/MacOS/BetterNCM');
    const env = { ...process.env, BETTERNCM_PROFILE: path.join(dir, 'profile') };
    assert.equal(execFileSync(exe, ['--version'], { encoding: 'utf8', env }).trim(), MAC_VERSION);
    assert.match(execFileSync(exe, ['help'], { encoding: 'utf8', env }), /Commands run as: '.*BetterNCM\.app\/Contents\/MacOS\/BetterNCM'/);
    // install-app is for checkouts; the app is already installed.
    assert.throws(() => execFileSync(exe, ['install-app'], { encoding: 'utf8', env, stdio: 'pipe' }), /self-contained/);
  });
});

test('rebuilding replaces our app but never another one', () => {
  withTmp((dir) => {
    const app = path.join(dir, 'BetterNCM.app');
    const node = stubNode(dir);
    buildApp({ node, out: app });
    fs.writeFileSync(path.join(app, 'Contents/Resources/stale'), '');
    buildApp({ node, out: app });
    assert.ok(!fs.existsSync(path.join(app, 'Contents/Resources/stale')));

    const other = path.join(dir, 'Other.app');
    fs.mkdirSync(path.join(other, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(other, 'Contents/Info.plist'), '<key>CFBundleIdentifier</key><string>com.example.other</string>');
    assert.throws(() => buildApp({ node, out: other }), /not BetterNCM\.app/);
    assert.ok(fs.existsSync(path.join(other, 'Contents/Info.plist')));
  });
});

test('install.sh parses and pins a Node 22 build per Mac architecture', () => {
  const sh = path.join(ROOT, 'install.sh');
  execFileSync('/bin/bash', ['-n', sh]);
  execFileSync('/bin/bash', ['-n', path.join(ROOT, 'app-wrapper/BetterNCM-standalone.sh')]);
  const text = fs.readFileSync(sh, 'utf8');
  // Node 23 and later need macOS 13.5; the app (like NCM 3) supports macOS 11.
  assert.match(text, /^NODE_VERSION=v22\.\d+\.\d+$/m);
  for (const arch of ['arm64', 'x64']) assert.match(text, new RegExp(`^NODE_SHA256_${arch}=[0-9a-f]{64}$`, 'm'));
});

test('build-app.mjs builds when started through a symlinked path (install.sh runs it from $TMPDIR)', () => {
  withTmp((dir) => {
    const link = path.join(dir, 'link');
    fs.symlinkSync(ROOT, link);
    const app = path.join(dir, 'BetterNCM.app');
    execFileSync(process.execPath, [path.join(link, 'scripts/build-app.mjs'), '--node', stubNode(dir), '--out', app]);
    assert.ok(fs.existsSync(path.join(app, 'Contents/MacOS/BetterNCM')));
  });
});
