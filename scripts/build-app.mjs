#!/usr/bin/env node
// Builds the self-contained BetterNCM.app: this project and a Node.js binary in one bundle, so it
// needs no Node install and no source checkout, and keeps working wherever the app is moved.
// Used by install.sh, the one-line installer.
//
//   node scripts/build-app.mjs --node <node binary> --out <dir>/BetterNCM.app [--node-license <file>]
//
// Layout:
//   Contents/MacOS/BetterNCM        app-wrapper/BetterNCM-standalone.sh
//   Contents/Resources/node/bin/node
//   Contents/Resources/app/         bin, src, dist, resources, vendor, package.json, LICENSE, README.md
//
// The app is not code-signed: its executable is a shell script, and the Node binary keeps the
// signature it came with. There is no icon in it; on its first run on a Mac, setup-app copies
// NetEase Cloud Music's icon from the installed app, which is not ours to ship.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const APP_FILES = ['bin', 'src', 'dist', 'resources', 'vendor', 'package.json', 'LICENSE', 'README.md'];
const BUNDLE_ID = 'cc.microblock.betterncm-mac';

function fail(msg) {
  process.stderr.write(`build-app: ${msg}\n`);
  process.exit(1);
}

function bundleIdOf(app) {
  const plist = path.join(app, 'Contents', 'Info.plist');
  try {
    return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(fs.readFileSync(plist, 'utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}

export function buildApp({ node, out, nodeLicense = null, root = ROOT }) {
  if (!fs.statSync(node, { throwIfNoEntry: false })?.isFile()) throw new Error(`no node binary at ${node}`);
  if (path.extname(out) !== '.app') throw new Error(`--out must end in .app: ${out}`);
  if (fs.existsSync(out)) {
    if (bundleIdOf(out) !== BUNDLE_ID) throw new Error(`${out} exists and is not BetterNCM.app; not touching it`);
    fs.rmSync(out, { recursive: true, force: true });
  }
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const contents = path.join(out, 'Contents');
  const res = path.join(contents, 'Resources');

  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'),
    fs.readFileSync(path.join(root, 'app-wrapper', 'Info.plist'), 'utf8').replaceAll('{{MAC_VERSION}}', () => version));
  const exe = path.join(contents, 'MacOS', 'BetterNCM');
  fs.copyFileSync(path.join(root, 'app-wrapper', 'BetterNCM-standalone.sh'), exe);
  fs.chmodSync(exe, 0o755);
  for (const lproj of ['zh-Hans.lproj', 'en.lproj']) {
    fs.mkdirSync(path.join(res, lproj), { recursive: true });
    fs.copyFileSync(path.join(root, 'app-wrapper', lproj, 'InfoPlist.strings'), path.join(res, lproj, 'InfoPlist.strings'));
  }

  fs.mkdirSync(path.join(res, 'node', 'bin'), { recursive: true });
  fs.copyFileSync(node, path.join(res, 'node', 'bin', 'node'));
  fs.chmodSync(path.join(res, 'node', 'bin', 'node'), 0o755);
  if (nodeLicense) fs.copyFileSync(nodeLicense, path.join(res, 'node', 'LICENSE'));

  for (const f of APP_FILES) {
    const src = path.join(root, f);
    if (!fs.existsSync(src)) throw new Error(`missing ${src}`);
    fs.cpSync(src, path.join(res, 'app', f), { recursive: true, filter: (p) => path.basename(p) !== '.DS_Store' });
  }
  if (!fs.existsSync(path.join(res, 'app', 'dist', 'framework.js'))) throw new Error('dist/framework.js is missing (npm run build:fw)');
  return { app: out, version };
}

// Run directly (not imported by the tests). Real paths: install.sh runs this from under $TMPDIR,
// /var/folders/..., which is a symlink to /private/var/folders, where import.meta.url points.
const isMain = () => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};

if (process.argv[1] && isMain()) {
  const { values } = parseArgs({
    options: { node: { type: 'string' }, out: { type: 'string' }, 'node-license': { type: 'string' } },
  });
  if (!values.node || !values.out) fail('usage: build-app.mjs --node <node binary> --out <dir>/BetterNCM.app [--node-license <file>]');
  try {
    const { app, version } = buildApp({ node: path.resolve(values.node), out: path.resolve(values.out), nodeLicense: values['node-license'] ?? null });
    console.log(`built ${app} (${version})`);
  } catch (e) {
    fail(e.message);
  }
}
