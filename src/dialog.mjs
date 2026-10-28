// macOS dialogs through osascript. Kept apart from launcher.mjs so the CLI can show an error
// without loading the CDP code.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

function osaString(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

async function osascript(script) {
  try {
    const { stdout } = await execFileP('/usr/bin/osascript', ['-e', script], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e) {
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout || '' };
  }
}

function alertScript(message, { title = 'BetterNCM', critical = true } = {}) {
  return `display alert ${osaString(title)} message ${osaString(message)} `
    + `as ${critical ? 'critical' : 'informational'} giving up after 120`;
}

// Modal yes/no dialog. Cancel, error or timeout all count as "no".
export async function confirmDialog(message, { ok = 'OK', cancel = 'Cancel', title = 'BetterNCM', timeoutSec = 300 } = {}) {
  const script = `display dialog ${osaString(message)} with title ${osaString(title)} `
    + `buttons {${osaString(cancel)}, ${osaString(ok)}} default button ${osaString(ok)} cancel button ${osaString(cancel)} `
    + `with icon caution giving up after ${timeoutSec}`;
  const r = await osascript(script);
  if (r.code !== 0) return false;
  return r.stdout.includes(`button returned:${ok}`) && !r.stdout.includes('gave up:true');
}

export async function alertDialog(message, opts) {
  await osascript(alertScript(message, opts));
}

// Shows the alert from a process of its own, so the caller can exit right away.
export function alertDialogDetached(message, opts) {
  try {
    spawn('/usr/bin/osascript', ['-e', alertScript(message, opts)], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* the log still has it */ }
}
