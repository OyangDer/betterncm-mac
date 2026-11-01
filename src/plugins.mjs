// Packed-plugin extraction and plugin enumeration (port of PluginManager.cpp).
import fs from 'node:fs';
import path from 'node:path';
import semver from '../vendor/semver/index.js'; // vendored (ISC), so a clone runs without npm install
import { PROJECT_ROOT, configParses, getDataPath, getNcmVersion, readConfigKey, writeConfigKey } from './config.mjs';
import { log } from './log.mjs';
import { readEntry, extractAll } from './zip.mjs';

const MARKET_MIN_VERSION = '0.7.2';
// Plugins shipped in resources/. RefinedNowPlayingNext 3.0.2 is the build the compat-rnp-*
// preludes were made against (MIT, resources/RefinedNowPlayingNext-LICENSE.txt).
const BUNDLED_PLUGINS = [
  { name: 'RefinedNowPlayingNext', file: 'RefinedNowPlayingNext-3.0.2.plugin', key: 'mac.seeded.RefinedNowPlayingNext' },
];
const DEFAULT_NCM_REQ = '> 2.10.2';
const DEFAULT_STARTUP_SCRIPT = 'startup_script.js';

// C++ getSlugName: spaces become '-', then ASCII characters other than [A-Za-z0-9-] are dropped.
// Non-ASCII characters are kept (the C++ check only looks at 0 < c < 255 on signed chars).
export function slugOf(name) {
  if (!name) return name ?? '';
  return String(name).replace(/ /g, '-').replace(/[\x01-\x7f]/g, (c) => (/[A-Za-z0-9-]/.test(c) ? c : ''));
}

function parseManifest(text) {
  return JSON.parse(String(text).replace(/^﻿/, ''));
}

function manifestSlug(m) {
  if (m.slug !== undefined) {
    if (typeof m.slug !== 'string') throw new Error('manifest slug is not a string');
    return m.slug;
  }
  return slugOf(typeof m.name === 'string' ? m.name : 'unknown');
}

// The slug becomes a directory name under plugins_runtime; never let it walk out of there.
function isSafeSlug(slug) {
  return typeof slug === 'string' && slug.length > 0 && slug !== '.' && slug !== '..' && !/[\\/\0]/.test(slug);
}

function readZipManifest(file) {
  return parseManifest(readEntry(file, 'manifest.json').toString('utf8'));
}

function marketVersionOf(file) {
  try {
    return readZipManifest(file).version;
  } catch {
    return null;
  }
}

function isOutdatedMarket(version) {
  const v = typeof version === 'string' ? semver.valid(version, { loose: true }) : null;
  if (!v) return true; // C++ semver::version() would throw on this; replace it with ours
  return semver.lt(v, MARKET_MIN_VERSION, { loose: true });
}

export function pluginManagerEnabled() {
  return readConfigKey('mac.pluginManager') === 'true';
}

// Installs each bundled plugin once, unless some version of it is already there (packed, or in
// plugins_dev). Done once per data dir (a config key), so a plugin the user deletes stays
// deleted. Not while config.json does not parse: the key would read as unset, and writing it
// would replace the user's broken file.
export function seedBundledPlugins() {
  if (!configParses()) {
    log('[plugins] config.json does not parse; not installing bundled plugins');
    return [];
  }
  const dp = getDataPath();
  const dir = path.join(dp, 'plugins');
  const seeded = [];
  for (const p of BUNDLED_PLUGINS) {
    if (readConfigKey(p.key, '') === 'true') continue;
    fs.mkdirSync(dir, { recursive: true });
    const packed = fs.readdirSync(dir).some((f) => {
      if (!f.endsWith('.plugin')) return false;
      try { return readZipManifest(path.join(dir, f)).name === p.name; } catch { return false; }
    });
    const dev = path.join(dp, 'plugins_dev');
    const inDev = fs.existsSync(dev) && fs.readdirSync(dev).some((d) => {
      try { return parseManifest(fs.readFileSync(path.join(dev, d, 'manifest.json'), 'utf8')).name === p.name; } catch { return false; }
    });
    const have = packed || inDev;
    if (!have) {
      fs.copyFileSync(path.join(PROJECT_ROOT, 'resources', p.file), path.join(dir, p.file));
      log(`[plugins] installed the bundled ${p.file}`);
      seeded.push(p.file);
    }
    writeConfigKey(p.key, 'true');
  }
  return seeded;
}

// Copies the bundled PluginMarket.plugin into plugins/ when it is missing or older than 0.7.2,
// while the plugin manager is shown (mac.pluginManager).
export function seedPluginMarket() {
  if (!pluginManagerEnabled()) return false;
  const src = path.join(PROJECT_ROOT, 'resources', 'PluginMarket.plugin');
  const dest = path.join(getDataPath(), 'plugins', 'PluginMarket.plugin');
  if (!fs.existsSync(src)) {
    log('[plugins] bundled PluginMarket.plugin is missing:', src);
    return false;
  }
  if (fs.existsSync(dest)) {
    const ver = marketVersionOf(dest);
    if (ver && !isOutdatedMarket(ver)) return false;
    log(`[plugins] replacing outdated PluginMarket (${ver ?? 'unreadable'})`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  log('[plugins] seeded PluginMarket.plugin');
  return true;
}

export function readDisableList() {
  let text;
  try {
    text = fs.readFileSync(path.join(getDataPath(), 'disable_list.txt'), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').map((l) => l.trim());
}

function ncmMajor(ver) {
  const v = semver.coerce(ver);
  return v ? v.major : NaN;
}

// Returns null when the plugin should be extracted, else the skip reason.
function filterReason(m, slug, ncmVer, disabled) {
  if (disabled.includes(slug)) return 'in disable_list.txt';
  if (ncmMajor(ncmVer) === 3 && m['ncm3-compatible'] !== true) return 'not ncm3-compatible';
  const req = m['ncm-version-req'] ?? DEFAULT_NCM_REQ;
  if (typeof req !== 'string') return 'invalid ncm-version-req';
  if (!semver.satisfies(ncmVer, req, { loose: true })) return `ncm-version-req "${req}" not satisfied by NCM ${ncmVer}`;
  return null;
}

function safeNcmVersion() {
  try {
    return getNcmVersion();
  } catch (e) {
    log('[plugins] cannot read the NCM version:', e.message);
    return null;
  }
}

// DESIGN.md section 4 / PluginManager.cpp:220-324. opts.ncmVersion overrides the Info.plist version.
export function extractPackedPlugins(opts = {}) {
  const dp = getDataPath();
  const pluginsDir = path.join(dp, 'plugins');
  const runtimeDir = path.join(dp, 'plugins_runtime');
  const lock = path.join(dp, 'PLUGIN_EXTRACTING_LOCK.lock');
  const ncmVer = opts.ncmVersion ?? safeNcmVersion() ?? '0.0.0';
  const loaded = [];
  const skipped = [];
  const skip = (file, reason) => {
    skipped.push({ file, reason });
    log(`[plugins] skip ${file}: ${reason}`);
  };

  fs.mkdirSync(dp, { recursive: true });
  fs.writeFileSync(lock, '');
  try {
    // The market follows mac.pluginManager wherever plugins are extracted again, not only at start.
    try { seedPluginMarket(); } catch (e) { log('[plugins] seeding PluginMarket failed:', e.message); }
    const disabled = readDisableList();

    // wipe the previous runtime (no native DLLs can be locked on macOS)
    if (fs.existsSync(runtimeDir)) {
      for (const name of fs.readdirSync(runtimeDir)) fs.rmSync(path.join(runtimeDir, name), { recursive: true, force: true });
    }
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(pluginsDir, { recursive: true });

    const files = fs.readdirSync(pluginsDir).filter((f) => f.endsWith('.plugin')).sort();
    for (const file of files) {
      const full = path.join(pluginsDir, file);
      try {
        if (!fs.statSync(full).isFile()) continue;
        let m = readZipManifest(full);

        if (m.name === 'PluginMarket' && !pluginManagerEnabled()) {
          skip(file, 'the plugin manager is hidden (mac.pluginManager)');
          continue;
        }
        if (m.name === 'PluginMarket' && isOutdatedMarket(m.version)) {
          seedPluginMarket();
          if (file !== 'PluginMarket.plugin') {
            skip(file, `outdated PluginMarket ${m.version}; using the bundled one`);
            continue;
          }
          m = readZipManifest(full);
        }

        const slug = manifestSlug(m);
        const reason = filterReason(m, slug, ncmVer, disabled);
        if (reason) {
          skip(file, reason);
          continue;
        }
        if (m.manifest_version !== 1) throw new Error('Unsupported manifest version.');
        if (!isSafeSlug(slug)) throw new Error(`unsafe slug ${JSON.stringify(slug)}`);
        if (m.native_plugin) log(`[plugins] ${slug}: native plugin ${m.native_plugin} ignored on macOS`);

        const dest = path.join(runtimeDir, slug);
        if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
        try {
          extractAll(full, dest);
          fs.writeFileSync(path.join(dest, '.plugin.path.meta'), '/plugins/' + file);
        } catch (e) {
          // a skipped plugin must not stay half-extracted where the loader would still find it
          fs.rmSync(dest, { recursive: true, force: true });
          throw e;
        }
        loaded.push(slug);
        log(`[plugins] loaded ${file} -> plugins_runtime/${slug} (${m.version ?? '?'})`);
      } catch (e) {
        skip(file, `error: ${e.message}`);
      }
    }
  } finally {
    fs.rmSync(lock, { force: true });
  }
  return { loaded, skipped };
}

function loadInPath(dir, dev) {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const pdir = path.join(dir, name);
    const mf = path.join(pdir, 'manifest.json');
    try {
      if (!fs.existsSync(mf)) continue;
      const manifest = parseManifest(fs.readFileSync(mf, 'utf8'));
      const slug = manifestSlug(manifest);
      out.push({ slug, path: pdir, manifest, dev });
    } catch (e) {
      log(`[plugins] cannot load ${pdir}: ${e.message}`);
    }
  }
  return out;
}

// Packed (extracted) plugins followed by dev plugins, sorted by slug, first one wins per slug.
export function getAllPlugins() {
  const dp = getDataPath();
  const all = [
    ...loadInPath(path.join(dp, 'plugins_runtime'), false),
    ...loadInPath(path.join(dp, 'plugins_dev'), true),
  ];
  all.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return all.filter((p, i) => i === 0 || all[i - 1].slug !== p.slug);
}

const APP_HTML_PREFIX = 'orpheus://orpheus/pub/app.html';
const APP_HTML_MAC = 'orpheus://orpheus/app.html';

function hijackEntry(slug, prefix, action) {
  if (!action || typeof action !== 'object') return null;
  const { type } = action;
  const id = typeof action.id === 'string' ? action.id : '';
  if (type === 'regex' || type === 'replace') {
    if (typeof action.from !== 'string' || typeof action.to !== 'string') return null;
    return { slug, id, prefix, type, from: action.from, to: action.to, code: null };
  }
  if (type === 'append' || type === 'prepend') {
    if (typeof action.code !== 'string') return null;
    return { slug, id, prefix, type, from: null, to: null, code: action.code };
  }
  return null;
}

// Hijack actions active for this NCM version (App.cpp:610-633), with the app.html prefix remapped.
// Callers handle safe mode (cpp_side_inject_feature_disabled).
export function collectHijacks(ncmVer) {
  const out = [];
  for (const p of getAllPlugins()) {
    const hijacks = p.manifest.hijacks;
    if (!hijacks || typeof hijacks !== 'object') continue;
    for (const [range, urlMap] of Object.entries(hijacks)) {
      let ok = false;
      try {
        ok = semver.satisfies(ncmVer, range, { loose: true });
      } catch {
        ok = false;
      }
      if (!ok || !urlMap || typeof urlMap !== 'object') continue;
      for (const [url, actions] of Object.entries(urlMap)) {
        const prefix = url.startsWith(APP_HTML_PREFIX) ? APP_HTML_MAC + url.slice(APP_HTML_PREFIX.length) : url;
        for (const action of Array.isArray(actions) ? actions : [actions]) {
          const h = hijackEntry(p.slug, prefix, action);
          if (h) out.push(h);
          else log(`[plugins] ${p.slug}: ignoring malformed hijack action for ${url}`);
        }
      }
    }
  }
  return out;
}

// Startup scripts (Plugin::getStartupScript), in getAllPlugins order.
export function collectStartupScripts() {
  const out = [];
  for (const p of getAllPlugins()) {
    const rel = typeof p.manifest.startup_script === 'string' ? p.manifest.startup_script : DEFAULT_STARTUP_SCRIPT;
    const file = path.resolve(p.path, rel);
    if (!file.startsWith(path.resolve(p.path) + path.sep)) continue;
    try {
      if (!fs.statSync(file).isFile()) continue;
      out.push({ slug: p.slug, code: fs.readFileSync(file, 'utf8') });
    } catch {
      // no startup script
    }
  }
  return out;
}
