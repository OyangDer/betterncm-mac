// Constants, data directory and config.json (flat string -> string map, same file as v2).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import semver from '../vendor/semver/index.js';
import { log } from './log.mjs';

export const BUNDLE_ID = 'com.netease.163music';
// NCM versions this was tested on (3.1.14); others are injected anyway, after one warning.
export const TESTED_NCM = '3.1.x';
export const TESTED_NCM_LABEL = '3.1.14';
export const BNCM_VERSION = '1.3.4';
export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
// package.json's version, the one `npm version` bumps for a release.
export const MAC_VERSION = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version;
// The self-contained BetterNCM.app (scripts/build-app.mjs) carries this project in
// Contents/Resources/app and its own Node.js; null in a source checkout.
export const STANDALONE_APP = standaloneApp(PROJECT_ROOT);

export function standaloneApp(root) {
  const app = path.resolve(root, '../../..');
  return path.basename(app).endsWith('.app') && path.relative(app, root) === path.join('Contents', 'Resources', 'app') ? app : null;
}

// v2's key: disables startup scripts and hijacks (the framework calls this "safe mode").
export const SAFE_MODE_KEY = 'cc.microblock.betterncm.cpp_side_inject_feature_disabled';

export const MAC_DEFAULTS = Object.freeze({
  'mac.cdpPort': '9222',
  'mac.bypassCSP': 'true',
  'mac.channelShim': 'true',
  'mac.allowExec': 'false',
  'mac.allowFsOutsideData': 'false',
  'mac.autoForceUpdate': 'false',
  // Look-and-feel changes (src/bundle.mjs OPTIONAL_PRELUDE). The RefinedNowPlayingNext ones are
  // on unless set to 'false'; the mini vinyl keeps spinning unless stopMiniVinyl is 'true'.
  'mac.rnpAppleStyle': 'true',
  'mac.stopMiniVinyl': 'false',
  'mac.rnpAutoLyricSize': 'true',
  // The lyric page in its own window (LYRICS-WINDOW.md) instead of RefinedNowPlayingNext, which
  // is then not loaded; 'false' brings RefinedNowPlayingNext and its compat-rnp-* preludes back.
  'mac.lyricsWindow': 'true',
  // BetterNCM's plugin manager and plugin market. Most market plugins do not work on macOS
  // (Windows DLLs and programs, NCM 2 pages), and RefinedNowPlayingNext comes bundled, so the
  // manager's button is hidden and the market not loaded unless this is 'true'.
  'mac.pluginManager': 'false',
});

const DATA_SUBDIRS = ['plugins', 'plugins_runtime', 'plugins_dev', 'log', 'run'];

export function getDataPath() {
  const p = process.env.BETTERNCM_PROFILE || path.join(os.homedir(), 'Library/Application Support/BetterNCM-mac');
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

export function ensureDataDirs() {
  const dp = getDataPath();
  for (const d of DATA_SUBDIRS) fs.mkdirSync(path.join(dp, d), { recursive: true });
}

function configPath() {
  return path.join(getDataPath(), 'config.json');
}

// False when config.json exists but is not a JSON object (readConfig then reads it as {}).
export function configParses() {
  let text;
  try {
    text = fs.readFileSync(configPath(), 'utf8');
  } catch {
    return true; // missing reads as {} on purpose
  }
  try {
    const obj = JSON.parse(text);
    return !!obj && typeof obj === 'object' && !Array.isArray(obj);
  } catch {
    return false;
  }
}

export function readConfig() {
  let text;
  try {
    text = fs.readFileSync(configPath(), 'utf8');
  } catch {
    return {};
  }
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    return out;
  } catch (e) {
    log('config.json is not valid JSON, ignoring it:', e.message);
    return {};
  }
}

// `def` falls back to the mac.* default when omitted.
export function readConfigKey(key, def) {
  const cfg = readConfig();
  if (Object.hasOwn(cfg, key)) return cfg[key];
  if (def === undefined) return MAC_DEFAULTS[key];
  return def;
}

export function writeConfigKey(key, value) {
  const cfg = readConfig();
  cfg[key] = String(value);
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A hand-edited file that does not parse reads as {}; keep a copy before writing over it.
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      const backup = `${file}.broken-${Date.now()}`;
      try {
        fs.copyFileSync(file, backup);
        log(`config.json did not parse; saved it as ${backup} before writing ${key}`);
      } catch { /* writing on is still better than failing */ }
    }
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
}

// All mac.* keys with defaults applied; this is what the page sees as __BNCM_CFG__.
export function getMacConfig() {
  const cfg = readConfig();
  const out = {};
  for (const [k, def] of Object.entries(MAC_DEFAULTS)) out[k] = Object.hasOwn(cfg, k) ? cfg[k] : def;
  return out;
}

const DEFAULT_NCM_APP = '/Applications/NeteaseMusic.app';

// NCM's bundle: BNCM_NCM_APP or config.json's mac.ncmApp, else the usual places, else Spotlight
// by bundle id. When none is found this stays the default path, so messages name a real place.
function resolveNcmApp() {
  const override = process.env.BNCM_NCM_APP || readConfig()['mac.ncmApp'];
  if (override) return override.replace(/\/+$/, '');
  const candidates = [DEFAULT_NCM_APP, path.join(os.homedir(), 'Applications/NeteaseMusic.app')];
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) return found;
  try {
    const hits = execFileSync('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${BUNDLE_ID}'`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).split('\n').filter((h) => h.endsWith('.app') && !h.includes('/.Trash/'));
    if (hits.length) return hits[0];
  } catch { /* Spotlight off or slow */ }
  return DEFAULT_NCM_APP;
}

export const NCM_APP = resolveNcmApp();

// -> 'ok' | 'untested' | 'unsupported'. NCM 2.x is a different app (WKWebView, no CDP).
export function ncmSupport(ver) {
  const v = semver.coerce(ver);
  if (!v || v.major < 3) return 'unsupported';
  return semver.satisfies(v, TESTED_NCM) ? 'ok' : 'untested';
}

export function isSafeMode() {
  return readConfigKey(SAFE_MODE_KEY, 'false') === 'true';
}

function plistValue(key) {
  return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(NCM_APP, 'Contents/Info.plist')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

// Read on every call: Sparkle may update the app between runs.
export function getNcmVersion() {
  try {
    return plistValue('CFBundleShortVersionString');
  } catch (e) {
    log('cannot read NCM version from', NCM_APP, e.message);
    return '0.0.0';
  }
}

export function getNcmBuild() {
  try {
    return plistValue('CFBundleVersion');
  } catch (e) {
    log('cannot read NCM build from', NCM_APP, e.message);
    return '0';
  }
}
