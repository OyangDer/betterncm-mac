// The login agent: a LaunchAgent that runs resources/agent/BNCMAgent (native/agent/main.swift).
// The agent waits for NetEase Cloud Music to start and then runs `launch --agent`, so NCM opened
// from its own icon, reopened at login or restarted gets BetterNCM without BetterNCM.app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT, MAC_VERSION, getDataPath } from './config.mjs';

export const AGENT_LABEL = 'cc.microblock.betterncm-mac.agent';
export const AGENT_BINARY = path.join(PROJECT_ROOT, 'resources/agent/BNCMAgent');

// Overridable for tests: a test must never load anything into the real launchd.
const agentsDir = () => process.env.BNCM_LAUNCH_AGENTS_DIR || path.join(os.homedir(), 'Library/LaunchAgents');
const useLaunchctl = () => !process.env.BNCM_LAUNCH_AGENTS_DIR;

export function agentPlistPath() {
  return path.join(agentsDir(), `${AGENT_LABEL}.plist`);
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The agent's plist. `launcher` is the command that runs the CLI ([wrapper] for the self-contained
 * app, [node, cli] for a checkout); the agent appends `launch --agent`.
 */
export function agentPlist({ launcher, dataPath = getDataPath(), profile = process.env.BETTERNCM_PROFILE, build = agentBuild() }) {
  const args = [AGENT_BINARY, ...launcher, 'launch', '--agent'];
  const env = profile ? `
  <key>EnvironmentVariables</key>
  <dict>
    <key>BETTERNCM_PROFILE</key>
    <string>${xml(profile)}</string>
  </dict>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<!-- betterncm-mac ${xml(MAC_VERSION)}, BNCMAgent ${xml(build)}: a new build reloads the agent -->
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <!-- restarted if it stops, but not once the app is gone (moved, or put in the Trash) -->
  <key>KeepAlive</key>
  <dict>
    <key>PathState</key>
    <dict>
      <key>${xml(AGENT_BINARY)}</key>
      <true/>
    </dict>
  </dict>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(dataPath, 'log/agent.log'))}</string>${env}
</dict>
</plist>
`;
}

// The agent binary's hash: an upgrade that changes it must restart the running agent, whose
// plist would otherwise read the same.
function agentBuild() {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(AGENT_BINARY)).digest('hex').slice(0, 16);
  } catch {
    return 'missing';
  }
}

function launchctl(...args) {
  try {
    execFileSync('/bin/launchctl', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const domain = () => `gui/${process.getuid()}`;

/** Writes the plist and (re)loads it, so the agent runs now and at every login. */
export function installAgent({ launcher }) {
  if (!fs.existsSync(AGENT_BINARY)) throw new Error(`${AGENT_BINARY} is missing`);
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.mkdirSync(path.join(getDataPath(), 'log'), { recursive: true });
  const file = agentPlistPath();
  const text = agentPlist({ launcher });
  const changed = (() => { try { return fs.readFileSync(file, 'utf8') !== text; } catch { return true; } })();
  if (changed) fs.writeFileSync(file, text);
  if (!useLaunchctl()) return { file, changed };
  // A changed plist is only read again after a bootout. launchd still lists the old agent for a
  // moment after bootout returns (an update once found it "loaded" then and never started the
  // new one), and a bootstrap in that moment fails: wait for it to go, and try again.
  if (changed) {
    launchctl('bootout', `${domain()}/${AGENT_LABEL}`);
    for (let i = 0; i < 30 && agentLoaded(); i++) sleep(100);
  }
  for (let i = 0; !agentLoaded(); i++) {
    if (launchctl('bootstrap', domain(), file)) continue;
    if (i >= 4) throw new Error(`launchctl bootstrap ${file} failed`);
    sleep(500);
  }
  return { file, changed };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Unloads the agent and removes its plist. -> whether there was one. */
export function uninstallAgent() {
  const file = agentPlistPath();
  const had = fs.existsSync(file);
  if (useLaunchctl()) launchctl('bootout', `${domain()}/${AGENT_LABEL}`);
  fs.rmSync(file, { force: true });
  return had;
}

export function agentLoaded() {
  return useLaunchctl() && launchctl('print', `${domain()}/${AGENT_LABEL}`);
}
