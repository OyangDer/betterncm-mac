#!/usr/bin/env node
// Vendors BetterNCM js-framework@44b4df2 into framework/ and applies patches/js-framework-mac.patch.
//
//   node scripts/vendor-framework.mjs [--src <clone>]          copy the pristine sources, then apply the patch
//   node scripts/vendor-framework.mjs --diff [--src <clone>]   regenerate the patch from the current framework/
//
// <clone> may also be given as BNCM_FRAMEWORK_SRC. Without it, the framework is cloned from GitHub
// into a temporary directory. framework/node_modules is kept across a re-vendor.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/BetterNCM/js-framework';
const COMMIT = '44b4df2';
const EXCLUDE = new Set(['.git', 'node_modules']);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FW_DIR = path.join(ROOT, 'framework');
const PATCH = path.join(ROOT, 'patches', 'js-framework-mac.patch');

function parseArgs(argv) {
  const args = { diff: false, src: process.env.BNCM_FRAMEWORK_SRC || null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--diff') args.diff = true;
    else if (argv[i] === '--src') args.src = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

// Copies a source tree, skipping .git and node_modules at any depth.
function copyTree(from, to) {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (p) => !EXCLUDE.has(path.basename(p)),
  });
}

// Returns a directory holding the pristine framework sources (no .git / node_modules).
function preparePristine(src, tmp) {
  let clone = src && path.resolve(src);
  if (!clone) {
    clone = path.join(tmp, 'clone');
    console.log(`cloning ${REPO} ...`);
    execFileSync('git', ['clone', '--quiet', REPO, clone], { stdio: 'inherit' });
    execFileSync('git', ['-C', clone, 'checkout', '--quiet', COMMIT], { stdio: 'inherit' });
  }
  if (fs.existsSync(path.join(clone, '.git'))) {
    const head = execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (!head.startsWith(COMMIT)) throw new Error(`${clone} is at ${head}, expected ${COMMIT}`);
    const dirty = execFileSync('git', ['-C', clone, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    if (dirty) throw new Error(`${clone} has local changes:\n${dirty}`);
  }
  const pristine = path.join(tmp, 'a');
  copyTree(clone, pristine);
  return pristine;
}

function vendor(pristine) {
  fs.mkdirSync(FW_DIR, { recursive: true });
  for (const name of fs.readdirSync(FW_DIR)) {
    if (name !== 'node_modules') fs.rmSync(path.join(FW_DIR, name), { recursive: true, force: true });
  }
  copyTree(pristine, FW_DIR);
  const r = spawnSync('patch', ['-p1', '--forward', '--batch', '-d', FW_DIR, '-i', PATCH], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`patch failed (exit ${r.status})`);
  console.log(`vendored js-framework@${COMMIT} into ${FW_DIR} with ${path.relative(ROOT, PATCH)}`);
}

function makeDiff(pristine, tmp) {
  const work = path.join(tmp, 'b');
  copyTree(FW_DIR, work);
  const r = spawnSync('diff', ['-ruN', '-x', 'node_modules', '-x', '.git', 'a', 'b'], {
    cwd: tmp,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 && r.status !== 1) throw new Error(`diff failed: ${r.stderr}`);
  // drop the timestamps so the patch only changes when the content does
  const text = r.stdout.replace(/^(---|\+\+\+) (\S+)\t.*$/gm, '$1 $2');
  fs.mkdirSync(path.dirname(PATCH), { recursive: true });
  fs.writeFileSync(PATCH, text);
  console.log(`wrote ${PATCH} (${text.split('\n').length} lines)`);
}

const args = parseArgs(process.argv.slice(2));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bncm-fw-'));
try {
  const pristine = preparePristine(args.src, tmp);
  if (args.diff) makeDiff(pristine, tmp);
  else vendor(pristine);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
