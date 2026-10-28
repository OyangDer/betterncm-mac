// Minimal Chrome DevTools Protocol client on the global WebSocket, with flattened sessions.
// Never call Page.captureScreenshot through this: it hangs on NetEase.
import { EventEmitter } from 'node:events';

const DEFAULT_TIMEOUT = 30000;

export class CdpError extends Error {
  constructor(method, error) {
    super(`${method}: ${error.message}${error.data ? ` (${error.data})` : ''}`);
    this.code = error.code;
    this.method = method;
  }
}

export class CdpConnection extends EventEmitter {
  #ws;
  #nextId = 0;
  #pending = new Map();
  closed = false;

  constructor(ws) {
    super();
    this.#ws = ws;
    ws.addEventListener('message', (ev) => this.#onMessage(ev.data));
    ws.addEventListener('close', () => this.#onClose());
    ws.addEventListener('error', () => this.#onClose());
  }

  #onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(p.method, msg.error));
      else p.resolve(msg.result || {});
      return;
    }
    if (msg.method) {
      // Listeners get (params, sessionId); session-scoped listeners use `${sessionId}:${method}`.
      this.emit(msg.method, msg.params || {}, msg.sessionId);
      if (msg.sessionId) this.emit(`${msg.sessionId}:${msg.method}`, msg.params || {});
    }
  }

  #onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`${p.method}: connection closed`));
    }
    this.#pending.clear();
    this.emit('close');
  }

  send(method, params = {}, sessionId, { timeout = DEFAULT_TIMEOUT } = {}) {
    if (this.closed) return Promise.reject(new Error(`${method}: connection closed`));
    const id = ++this.#nextId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = timeout > 0
        ? setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`${method}: timed out after ${timeout} ms`));
        }, timeout)
        : null;
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#ws.send(JSON.stringify(msg));
      } catch (e) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  // A view bound to one flattened session.
  session(sessionId) {
    return {
      id: sessionId,
      send: (method, params, opts) => this.send(method, params, sessionId, opts),
      on: (method, fn) => this.on(`${sessionId}:${method}`, fn),
      off: (method, fn) => this.off(`${sessionId}:${method}`, fn),
    };
  }

  close() {
    try { this.#ws.close(); } catch { /* already closed */ }
    this.#onClose();
  }
}

export function connect(wsUrl, { timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(`CDP connect timed out: ${wsUrl}`));
    }, timeout);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(new CdpConnection(ws));
    }, { once: true });
    ws.addEventListener('error', (ev) => {
      clearTimeout(timer);
      reject(new Error(`CDP connect failed: ${wsUrl}${ev.message ? ` (${ev.message})` : ''}`));
    }, { once: true });
  });
}

async function getJson(port, p, timeout) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`GET ${p} -> ${res.status}`);
  return res.json();
}

// /json/version: {Browser, webSocketDebuggerUrl, ...}
export function fetchVersion(port, { timeout = 2000 } = {}) {
  return getJson(port, '/json/version', timeout);
}

// /json/list: [{id, type, title, url, webSocketDebuggerUrl}]
export function fetchTargets(port, { timeout = 2000 } = {}) {
  return getJson(port, '/json/list', timeout);
}

export async function connectBrowser(port, opts) {
  const ver = await fetchVersion(port);
  if (!ver.webSocketDebuggerUrl) throw new Error(`no browser websocket on port ${port}`);
  return connect(ver.webSocketDebuggerUrl, opts);
}
