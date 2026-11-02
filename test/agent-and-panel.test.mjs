// The login agent's plist and install/uninstall (in a temp folder, never the real launchd), NCM's
// process age, and the plugin panel's list and switches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bncm-agent-')));
process.env.BETTERNCM_PROFILE = path.join(TMP, 'profile');
process.env.BNCM_LAUNCH_AGENTS_DIR = path.join(TMP, 'LaunchAgents');
fs.mkdirSync(path.join(TMP, 'profile/plugins'), { recursive: true });

const agent = await import('../src/agent.mjs');
const { parseEtime } = await import('../src/launcher.mjs');
const plugins = await import('../src/plugins.mjs');
const { PROJECT_ROOT } = await import('../src/config.mjs');

function makeZip(file, entries) {
  execFileSync('/usr/bin/python3', ['-I', '-c', `
import sys, json, zipfile
entries = json.loads(sys.argv[2])
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    for name, body in entries.items():
        z.writestr(name, body)
`, file, JSON.stringify(entries)]);
}

test('the agent plist runs BNCMAgent with the launcher and launch --agent, and parses', () => {
  const text = agent.agentPlist({ launcher: ['/Apps/Better NCM.app/Contents/MacOS/BetterNCM'], dataPath: '/d & d', profile: '/p<1>' });
  const file = path.join(TMP, 'check.plist');
  fs.writeFileSync(file, text);
  const json = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
  assert.equal(json.Label, agent.AGENT_LABEL);
  assert.deepEqual(json.ProgramArguments, [agent.AGENT_BINARY, '/Apps/Better NCM.app/Contents/MacOS/BetterNCM', 'launch', '--agent']);
  assert.equal(json.RunAtLoad, true);
  assert.deepEqual(json.KeepAlive, { PathState: { [agent.AGENT_BINARY]: true } }); // not once the app is gone
  assert.equal(json.AbandonProcessGroup, true);
  assert.equal(json.StandardErrorPath, '/d & d/log/agent.log');
  assert.equal(json.EnvironmentVariables.BETTERNCM_PROFILE, '/p<1>');
});

test('installAgent writes the plist once and uninstallAgent removes it, without launchctl', () => {
  const r1 = agent.installAgent({ launcher: ['/x/node', '/x/cli.mjs'] });
  assert.equal(r1.file, path.join(TMP, 'LaunchAgents', `${agent.AGENT_LABEL}.plist`));
  assert.equal(r1.changed, true);
  assert.equal(agent.installAgent({ launcher: ['/x/node', '/x/cli.mjs'] }).changed, false);
  assert.equal(agent.installAgent({ launcher: ['/y/node', '/x/cli.mjs'] }).changed, true);
  // a different agent build reloads it, though the paths are the same
  assert.notEqual(agent.agentPlist({ launcher: ['/y/node'], build: 'aaaa' }), agent.agentPlist({ launcher: ['/y/node'], build: 'bbbb' }));
  assert.equal(agent.agentLoaded(), false);
  assert.equal(agent.uninstallAgent(), true);
  assert.equal(fs.existsSync(r1.file), false);
  assert.equal(agent.uninstallAgent(), false);
});

test('the agent binary is committed, universal and executable', () => {
  const bin = path.join(PROJECT_ROOT, 'resources/agent/BNCMAgent');
  fs.accessSync(bin, fs.constants.X_OK);
  const info = execFileSync('/usr/bin/lipo', ['-info', bin], { encoding: 'utf8' });
  assert.match(info, /arm64/);
  assert.match(info, /x86_64/);
});

test('parseEtime reads ps etime', () => {
  assert.equal(parseEtime('00:07'), 7);
  assert.equal(parseEtime('  01:30\n'), 90);
  assert.equal(parseEtime('02:00:05'), 7205);
  assert.equal(parseEtime('1-00:00:01'), 86401);
  assert.equal(parseEtime(''), null);
  assert.equal(parseEtime('garbage'), null);
});

test('listInstalledPlugins and setPluginEnabled keep disable_list.txt in step', () => {
  const dir = path.join(TMP, 'profile/plugins');
  makeZip(path.join(dir, 'a.plugin'), { 'manifest.json': JSON.stringify({ manifest_version: 1, name: 'Alpha Plugin', version: '1.0', author: 'me', 'ncm3-compatible': true, injects: {} }) });
  makeZip(path.join(dir, 'b.plugin'), { 'manifest.json': JSON.stringify({ manifest_version: 1, name: 'Beta', slug: 'beta', 'ncm3-compatible': false, injects: {} }) });
  makeZip(path.join(dir, 'm.plugin'), { 'manifest.json': JSON.stringify({ manifest_version: 1, name: 'PluginMarket', 'ncm3-compatible': true, injects: {} }) });
  fs.writeFileSync(path.join(TMP, 'profile/disable_list.txt'), 'someone-else\n');

  let list = plugins.listInstalledPlugins({ ncmVersion: '3.1.14' });
  assert.deepEqual(list.map((p) => [p.slug, p.enabled]), [['Alpha-Plugin', true], ['beta', true]]); // the market is hidden
  assert.equal(list[0].author, 'me');
  assert.equal(list[1].note, '不支持这个版本的网易云');

  plugins.setPluginEnabled('Alpha-Plugin', false);
  assert.equal(fs.readFileSync(path.join(TMP, 'profile/disable_list.txt'), 'utf8'), 'someone-else\nAlpha-Plugin\n');
  list = plugins.listInstalledPlugins({ ncmVersion: '3.1.14' });
  assert.equal(list[0].enabled, false);
  assert.equal(list[0].note, '');
  plugins.setPluginEnabled('Alpha-Plugin', false); // no duplicate line
  plugins.setPluginEnabled('Alpha-Plugin', true);
  assert.equal(fs.readFileSync(path.join(TMP, 'profile/disable_list.txt'), 'utf8'), 'someone-else\n');
  assert.throws(() => plugins.setPluginEnabled('../x', false), /bad plugin slug/);
});
