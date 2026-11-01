// Extraction, filters, hijack collection and startup scripts.
// BNCM_SAMPLE_PLUGINS: a directory of real .plugin files (StyleSnippet, ZoomNCM, advanced-playbar,
// material-u-theme-ncmv3, RefinedNowPlayingNext, Apple-Musiclike-lyrics, LyricBarBlur). Tests that
// need them are skipped without it. BNCM_TEST_TMP chooses where the temp profile goes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP_ROOT = process.env.BNCM_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const DP = fs.realpathSync(fs.mkdtempSync(path.join(TMP_ROOT, 'bncm-plugins-')));
process.env.BETTERNCM_PROFILE = DP;

const SAMPLES = process.env.BNCM_SAMPLE_PLUGINS;
const SAMPLE_FILES = [
  'StyleSnippet', 'ZoomNCM', 'advanced-playbar', 'material-u-theme-ncmv3',
  'RefinedNowPlayingNext', 'Apple-Musiclike-lyrics', 'LyricBarBlur',
];
const haveSamples = !!SAMPLES && SAMPLE_FILES.every((f) => fs.existsSync(path.join(SAMPLES, f + '.plugin')));
const needSamples = haveSamples ? {} : { skip: 'set BNCM_SAMPLE_PLUGINS to a directory of sample .plugin files' };

const plugins = await import('../src/plugins.mjs');
const { PROJECT_ROOT } = await import('../src/config.mjs');

const PLUGINS = path.join(DP, 'plugins');
const RUNTIME = path.join(DP, 'plugins_runtime');
const DEV = path.join(DP, 'plugins_dev');

function makeZip(file, entries) {
  execFileSync('/usr/bin/python3', ['-I', '-c', `
import sys, json, zipfile
entries = json.loads(sys.argv[2])
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    for name, body in entries.items():
        z.writestr(name, body)
`, file, JSON.stringify(entries)]);
}

function manifestJson(m) {
  return JSON.stringify({ manifest_version: 1, 'ncm3-compatible': true, injects: { Main: [{ file: 'main.js' }] }, ...m });
}

function resetProfile(withSamples = true) {
  for (const d of [PLUGINS, RUNTIME, DEV]) {
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
  }
  fs.rmSync(path.join(DP, 'disable_list.txt'), { force: true });
  fs.rmSync(path.join(DP, 'config.json'), { force: true });
  if (withSamples && haveSamples) for (const f of SAMPLE_FILES) fs.copyFileSync(path.join(SAMPLES, f + '.plugin'), path.join(PLUGINS, f + '.plugin'));
}

before(() => resetProfile());
after(() => fs.rmSync(DP, { recursive: true, force: true }));

test('slugOf follows the C++ rule', () => {
  assert.equal(plugins.slugOf('StyleSnippet'), 'StyleSnippet');
  assert.equal(plugins.slugOf('Material You Theme (NCM v3)'), 'Material-You-Theme-NCM-v3');
  assert.equal(plugins.slugOf('RefinedNowPlaying Enhanced'), 'RefinedNowPlaying-Enhanced');
  assert.equal(plugins.slugOf('FluentProgressBar (优化版)'), 'FluentProgressBar-优化版');
  assert.equal(plugins.slugOf('类苹果歌词'), '类苹果歌词');
  assert.equal(plugins.slugOf('a/../b.c_d'), 'abcd');
  assert.equal(plugins.slugOf(''), '');
});

test('extraction applies ncm3-compatible and ncm-version-req filters', needSamples, () => {
  resetProfile();
  fs.mkdirSync(path.join(RUNTIME, 'stale'), { recursive: true });
  const res = plugins.extractPackedPlugins({ ncmVersion: '3.1.14' });

  assert.deepEqual([...res.loaded].sort(), [
    'Apple-Musiclike-lyrics', 'RefinedNowPlayingNext', 'StyleSnippet', 'ZoomNCM', 'material-u-theme-ncmv3',
  ]);
  const reasons = Object.fromEntries(res.skipped.map((s) => [s.file, s.reason]));
  assert.match(reasons['advanced-playbar.plugin'], /ncm-version-req ">= 3.1.20"/);
  assert.match(reasons['LyricBarBlur.plugin'], /not ncm3-compatible/);

  assert.deepEqual(fs.readdirSync(RUNTIME).sort(), [...res.loaded].sort());
  assert.equal(fs.readFileSync(path.join(RUNTIME, 'StyleSnippet', '.plugin.path.meta'), 'utf8'), '/plugins/StyleSnippet.plugin');
  assert.equal(
    fs.readFileSync(path.join(RUNTIME, 'material-u-theme-ncmv3', '.plugin.path.meta'), 'utf8'),
    '/plugins/material-u-theme-ncmv3.plugin',
  );
  assert.ok(fs.existsSync(path.join(RUNTIME, 'StyleSnippet', 'manifest.json')));
  assert.ok(fs.existsSync(path.join(RUNTIME, 'StyleSnippet', 'startup_script.js')));
  assert.equal(fs.existsSync(path.join(DP, 'PLUGIN_EXTRACTING_LOCK.lock')), false);
});

test('a newer NCM unlocks ncm-version-req plugins', needSamples, () => {
  resetProfile();
  const res = plugins.extractPackedPlugins({ ncmVersion: '3.1.39' });
  assert.ok(res.loaded.includes('advanced-playbar'));
  const old = plugins.extractPackedPlugins({ ncmVersion: '3.1.10' });
  assert.ok(!old.loaded.includes('RefinedNowPlayingNext')); // "> 3.1.11"
  assert.ok(old.loaded.includes('StyleSnippet'));
});

test('disable_list.txt skips slugs (lines are trimmed)', needSamples, () => {
  resetProfile();
  fs.writeFileSync(path.join(DP, 'disable_list.txt'), '  ZoomNCM \r\nStyleSnippet\n');
  const res = plugins.extractPackedPlugins({ ncmVersion: '3.1.14' });
  assert.ok(!res.loaded.includes('ZoomNCM'));
  assert.ok(!res.loaded.includes('StyleSnippet'));
  assert.ok(res.skipped.some((s) => s.file === 'ZoomNCM.plugin' && /disable_list/.test(s.reason)));
});

test('a .plugin with traversal entries, a bad manifest version or a bad slug is skipped', () => {
  resetProfile(false);
  makeZip(path.join(PLUGINS, 'evil.plugin'), { 'manifest.json': manifestJson({ name: 'Evil' }), '../../pwned.txt': 'x' });
  makeZip(path.join(PLUGINS, 'v2.plugin'), { 'manifest.json': manifestJson({ name: 'V2', manifest_version: 2 }) });
  makeZip(path.join(PLUGINS, 'slug.plugin'), { 'manifest.json': manifestJson({ name: 'S', slug: '../escape' }) });
  makeZip(path.join(PLUGINS, 'nomanifest.plugin'), { 'main.js': '' });
  makeZip(path.join(PLUGINS, 'ok.plugin'), { 'manifest.json': '﻿' + manifestJson({ name: 'Fine Plugin!' }), 'main.js': '' });
  const res = plugins.extractPackedPlugins({ ncmVersion: '3.1.14' });
  assert.deepEqual(res.loaded, ['Fine-Plugin']);
  const reasons = Object.fromEntries(res.skipped.map((s) => [s.file, s.reason]));
  assert.match(reasons['evil.plugin'], /parent-directory entry/);
  assert.match(reasons['v2.plugin'], /Unsupported manifest version/);
  assert.match(reasons['slug.plugin'], /unsafe slug/);
  assert.match(reasons['nomanifest.plugin'], /manifest.json not found/);
  assert.equal(fs.existsSync(path.join(DP, 'pwned.txt')), false);
  assert.equal(fs.existsSync(path.join(path.dirname(DP), 'pwned.txt')), false);
  assert.deepEqual(fs.readdirSync(RUNTIME), ['Fine-Plugin']);
});

test('backslash-separated (Windows-made) plugins load; a failed extraction leaves nothing behind', () => {
  resetProfile(false);
  execFileSync('/usr/bin/python3', ['-I', '-c', `
import sys, zipfile
def make(file, entries):
    with zipfile.ZipFile(file, 'w') as z:
        for name, body, system, attr in entries:
            i = zipfile.ZipInfo(name); i.create_system = system
            if attr: i.external_attr = attr
            z.writestr(i, body)
make(sys.argv[1], [('manifest.json', sys.argv[3], 0, 0), ('sub\\\\a.js', 'A', 0, 0)])
make(sys.argv[2], [('manifest.json', sys.argv[4], 3, 0), ('esc', 'sub/../../outside', 2, 0o120777 << 16)])
`, path.join(PLUGINS, 'bs.plugin'), path.join(PLUGINS, 'link.plugin'), manifestJson({ name: 'Bs' }), manifestJson({ name: 'Link' })]);
  const res = plugins.extractPackedPlugins({ ncmVersion: '3.1.14' });
  assert.deepEqual(res.loaded, ['Bs']);
  assert.equal(fs.readFileSync(path.join(RUNTIME, 'Bs', 'sub', 'a.js'), 'utf8'), 'A');
  assert.equal(fs.readFileSync(path.join(RUNTIME, 'Bs', '.plugin.path.meta'), 'utf8'), '/plugins/bs.plugin');
  assert.match(res.skipped.find((s) => s.file === 'link.plugin').reason, /symlink/);
  assert.deepEqual(fs.readdirSync(RUNTIME), ['Bs']);
});

function showPluginManager() {
  fs.writeFileSync(path.join(DP, 'config.json'), JSON.stringify({ 'mac.pluginManager': 'true' }));
}

test('an outdated PluginMarket is replaced by the bundled one', () => {
  resetProfile();
  showPluginManager();
  makeZip(path.join(PLUGINS, 'PluginMarket.plugin'), {
    'manifest.json': manifestJson({ name: 'PluginMarket', version: '0.7.0', injects: { Main: [{ file: './main.js' }] } }),
    'main.js': '// old',
  });
  const res = plugins.extractPackedPlugins({ ncmVersion: '3.1.14' });
  assert.ok(res.loaded.includes('PluginMarket'));
  const m = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'PluginMarket', 'manifest.json'), 'utf8'));
  const bundled = JSON.parse(execFileSync('/usr/bin/unzip', ['-p', path.join(PROJECT_ROOT, 'resources', 'PluginMarket.plugin'), 'manifest.json'], { encoding: 'utf8' }));
  assert.equal(m.version, bundled.version);
  assert.notEqual(m.version, '0.7.0');
});

test('seedPluginMarket copies the market only when missing or outdated', () => {
  resetProfile();
  showPluginManager();
  const dest = path.join(PLUGINS, 'PluginMarket.plugin');
  assert.equal(plugins.seedPluginMarket(), true);
  assert.ok(fs.existsSync(dest));
  assert.equal(plugins.seedPluginMarket(), false);
  makeZip(dest, { 'manifest.json': manifestJson({ name: 'PluginMarket', version: '0.9.9' }) });
  assert.equal(plugins.seedPluginMarket(), false); // newer than the bundled one: kept
  makeZip(dest, { 'manifest.json': manifestJson({ name: 'PluginMarket', version: '0.6.10' }) });
  assert.equal(plugins.seedPluginMarket(), true);
});

test('getAllPlugins merges runtime and dev plugins, sorted and unique by slug', needSamples, () => {
  resetProfile();
  plugins.extractPackedPlugins({ ncmVersion: '3.1.14' });
  fs.mkdirSync(path.join(DEV, 'hello'), { recursive: true });
  fs.writeFileSync(path.join(DEV, 'hello', 'manifest.json'), manifestJson({ name: 'hello' }));
  fs.mkdirSync(path.join(DEV, 'dup'), { recursive: true });
  fs.writeFileSync(path.join(DEV, 'dup', 'manifest.json'), manifestJson({ name: 'ZoomNCM-dev', slug: 'ZoomNCM' }));
  fs.mkdirSync(path.join(DEV, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(DEV, 'broken', 'manifest.json'), '{nope');
  fs.mkdirSync(path.join(DEV, 'empty'), { recursive: true });

  const all = plugins.getAllPlugins();
  const slugs = all.map((p) => p.slug);
  assert.deepEqual(slugs, [...slugs].sort());
  assert.equal(new Set(slugs).size, slugs.length);
  assert.ok(slugs.includes('hello'));
  const hello = all.find((p) => p.slug === 'hello');
  assert.equal(hello.dev, true);
  assert.equal(hello.path, path.join(DEV, 'hello'));
  const zoom = all.find((p) => p.slug === 'ZoomNCM');
  assert.equal(zoom.dev, false); // packed copy wins over the dev duplicate
  assert.equal(all.find((p) => p.slug === 'material-u-theme-ncmv3').manifest.name, 'Material You Theme (NCM v3)');
});

test('collectHijacks filters by NCM version and remaps the app.html prefix', needSamples, () => {
  resetProfile();
  plugins.extractPackedPlugins({ ncmVersion: '3.1.14' });
  const hs = plugins.collectHijacks('3.1.14');

  const rnpn = hs.filter((h) => h.slug === 'RefinedNowPlayingNext');
  assert.deepEqual(rnpn.map((h) => [h.prefix, h.type, h.id]), [
    ['orpheus://orpheus/pub/core', 'replace', ''],
    ['orpheus://orpheus/pub/hybrid/vendors', 'replace', 'redux-dispatch-hook'],
  ]);
  assert.equal(rnpn[1].from, '"sagaEffects.put"),');
  assert.equal(rnpn[1].to, '"sagaEffects.put"),window?.rnpDispatchHook?.(n),');

  const amll = hs.filter((h) => h.slug === 'Apple-Musiclike-lyrics');
  const csp = amll.find((h) => h.id === 'csp-worker');
  assert.equal(csp.prefix, 'orpheus://orpheus/app.html');
  assert.match(csp.from, /Content-Security-Policy/);
  assert.ok(amll.some((h) => h.id === 'redux-dispatch-hook' && h.prefix === 'orpheus://orpheus/pub/hybrid/vendors'));

  // a range that excludes this version contributes nothing
  assert.equal(plugins.collectHijacks('2.10.3').filter((h) => h.slug === 'RefinedNowPlayingNext').length, 0);
  assert.equal(plugins.collectHijacks('2.10.5').filter((h) => h.slug === 'RefinedNowPlayingNext').length, 1);
});

test('collectHijacks handles arrays, append/prepend and malformed actions', () => {
  resetProfile();
  fs.mkdirSync(path.join(DEV, 'hj'), { recursive: true });
  fs.writeFileSync(path.join(DEV, 'hj', 'manifest.json'), manifestJson({
    name: 'hj',
    hijacks: {
      '>= 3.0.0': {
        'orpheus://orpheus/pub/app.html?x': [
          { type: 'append', id: 'a', code: '/*a*/' },
          { type: 'prepend', code: '/*p*/' },
          { type: 'regex', id: 'r', from: '(foo)', to: '$1bar' },
          { type: 'bogus', id: 'b' },
          { type: 'replace', id: 'nofrom', to: 'x' },
        ],
      },
      'not a range': { 'orpheus://orpheus/pub/core': { type: 'append', code: 'x' } },
    },
  }));
  const hs = plugins.collectHijacks('3.1.14');
  assert.deepEqual(hs.map((h) => [h.slug, h.id, h.type, h.prefix]), [
    ['hj', 'a', 'append', 'orpheus://orpheus/app.html?x'],
    ['hj', '', 'prepend', 'orpheus://orpheus/app.html?x'],
    ['hj', 'r', 'regex', 'orpheus://orpheus/app.html?x'],
  ]);
  assert.equal(hs[0].code, '/*a*/');
  assert.equal(hs[2].to, '$1bar');
});

test('collectStartupScripts reads startup_script.js (or the manifest override) per plugin', needSamples, () => {
  resetProfile();
  plugins.extractPackedPlugins({ ncmVersion: '3.1.14' });
  fs.mkdirSync(path.join(DEV, 'custom'), { recursive: true });
  fs.writeFileSync(path.join(DEV, 'custom', 'manifest.json'), manifestJson({ name: 'custom', startup_script: 'boot.js' }));
  fs.writeFileSync(path.join(DEV, 'custom', 'boot.js'), 'window.__boot = 1;');
  fs.mkdirSync(path.join(DEV, 'sneaky'), { recursive: true });
  fs.writeFileSync(path.join(DEV, 'sneaky', 'manifest.json'), manifestJson({ name: 'sneaky', startup_script: '../../config.json' }));

  const scripts = plugins.collectStartupScripts();
  const bySlug = Object.fromEntries(scripts.map((s) => [s.slug, s.code]));
  assert.ok('StyleSnippet' in bySlug);
  assert.equal(bySlug.StyleSnippet, fs.readFileSync(path.join(RUNTIME, 'StyleSnippet', 'startup_script.js'), 'utf8'));
  assert.equal(bySlug.custom, 'window.__boot = 1;');
  assert.ok(!('sneaky' in bySlug));
  assert.ok(!('advanced-playbar' in bySlug)); // filtered out at 3.1.14, never extracted
  assert.deepEqual(scripts.map((s) => s.slug), [...scripts.map((s) => s.slug)].sort());
});

test('while the plugin manager is hidden, the market is neither seeded nor loaded', () => {
  resetProfile(false);
  assert.equal(plugins.seedPluginMarket(), false);
  assert.ok(!fs.existsSync(path.join(PLUGINS, 'PluginMarket.plugin')));
  fs.copyFileSync(path.join(PROJECT_ROOT, 'resources', 'PluginMarket.plugin'), path.join(PLUGINS, 'PluginMarket.plugin'));
  const res = plugins.extractPackedPlugins({ ncmVersion: '3.1.14' });
  assert.ok(!res.loaded.includes('PluginMarket'));
  assert.match(res.skipped.find((x) => x.file === 'PluginMarket.plugin').reason, /mac\.pluginManager/);
});

test('the bundled RefinedNowPlayingNext is installed once, and not over another version', () => {
  resetProfile(false);
  assert.deepEqual(plugins.seedBundledPlugins(), ['RefinedNowPlayingNext-3.0.2.plugin']);
  assert.ok(fs.existsSync(path.join(PLUGINS, 'RefinedNowPlayingNext-3.0.2.plugin')));
  const setLyricsWindow = (v) => {
    const f = path.join(DP, 'config.json');
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), 'mac.lyricsWindow': v }));
  };
  setLyricsWindow('false');
  assert.ok(plugins.extractPackedPlugins({ ncmVersion: '3.1.14' }).loaded.includes('RefinedNowPlayingNext'));
  setLyricsWindow('true');
  // Deleted by the user: stays deleted.
  fs.rmSync(path.join(PLUGINS, 'RefinedNowPlayingNext-3.0.2.plugin'));
  assert.deepEqual(plugins.seedBundledPlugins(), []);
  assert.ok(!fs.existsSync(path.join(PLUGINS, 'RefinedNowPlayingNext-3.0.2.plugin')));
  // A data dir that already has some version (under any file name) keeps it.
  resetProfile(false);
  makeZip(path.join(PLUGINS, 'rnp-own.plugin'), { 'manifest.json': manifestJson({ name: 'RefinedNowPlayingNext', version: '3.1.0' }) });
  assert.deepEqual(plugins.seedBundledPlugins(), []);
  assert.deepEqual(fs.readdirSync(PLUGINS), ['rnp-own.plugin']);
});

test('bundled plugins are not installed over a plugins_dev copy or while config.json is broken', () => {
  resetProfile(false);
  fs.mkdirSync(path.join(DEV, 'my-rnp'), { recursive: true });
  fs.writeFileSync(path.join(DEV, 'my-rnp', 'manifest.json'), manifestJson({ name: 'RefinedNowPlayingNext' }));
  assert.deepEqual(plugins.seedBundledPlugins(), []);
  assert.deepEqual(fs.readdirSync(PLUGINS), []);

  resetProfile(false);
  const broken = '{"mac.rnpAppleStyle": "false",}';
  fs.writeFileSync(path.join(DP, 'config.json'), broken);
  assert.deepEqual(plugins.seedBundledPlugins(), []);
  assert.deepEqual(fs.readdirSync(PLUGINS), []);
  assert.equal(fs.readFileSync(path.join(DP, 'config.json'), 'utf8'), broken, 'left for the user to fix');
});

test('the lyrics window keeps RefinedNowPlayingNext out, and turning it off brings it back', () => {
  resetProfile(false);
  plugins.seedBundledPlugins();
  const res = plugins.extractPackedPlugins({ ncmVersion: '3.1.14' });
  assert.ok(!res.loaded.includes('RefinedNowPlayingNext'));
  assert.ok(res.skipped.some((s) => /lyrics window/.test(s.reason)));
  fs.writeFileSync(path.join(DP, 'config.json'), JSON.stringify({ 'mac.lyricsWindow': 'false' }));
  assert.ok(plugins.extractPackedPlugins({ ncmVersion: '3.1.14' }).loaded.includes('RefinedNowPlayingNext'));
});

test('turning the plugin manager on brings the market in at the next extraction', () => {
  resetProfile(false);
  assert.ok(!plugins.extractPackedPlugins({ ncmVersion: '3.1.14' }).loaded.includes('PluginMarket'));
  showPluginManager();
  assert.ok(plugins.extractPackedPlugins({ ncmVersion: '3.1.14' }).loaded.includes('PluginMarket'));
});
