// Tiny logger: stderr with an ISO timestamp, plus an append-only file once setLogFile() is called.
import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

let logFile = null;
let quiet = false;

function fmt(x) {
  if (typeof x === 'string') return x;
  if (x instanceof Error) return x.stack || String(x);
  return inspect(x, { depth: 4, breakLength: Infinity });
}

export function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(fmt).join(' ')}\n`;
  if (!quiet) process.stderr.write(line);
  if (logFile) {
    try { fs.appendFileSync(logFile, line); } catch { /* the log must never throw */ }
  }
}

export function setLogFile(p) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Keep one rotated copy so the log cannot grow without bound.
    if (fs.existsSync(p) && fs.statSync(p).size > MAX_LOG_BYTES) fs.renameSync(p, p + '.1');
    logFile = p;
  } catch (e) {
    logFile = null;
    log('cannot open log file', p, e.message);
  }
}

// Daemon mode: the file is the record, stderr is redirected elsewhere by the wrapper.
export function setQuiet(q) {
  quiet = !!q;
}
