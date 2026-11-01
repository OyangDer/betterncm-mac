// Messages between the page, the host (BNCMLyrics) and the bridge in NCM's page (LYRICS-WINDOW.md).
const handlers = new Map(); // type -> Set(fn)
const pending = new Map(); // rid -> {resolve, reject, timer}
let ridSeq = 0;
// rids are unique per page load: a reply to a request from before a reload must not resolve a new one
const BOOT = Math.random().toString(36).slice(2, 8);

function post(msg) {
  try {
    window.webkit?.messageHandlers?.b?.postMessage(msg);
  } catch (e) {
    console.error('post failed', e);
  }
}

/** A command for the bridge in NCM's page ({c: ...}). */
export function send(c, fields = {}) {
  post({ c, ...fields });
}

/** A request to the host ({h: ...}). */
export function host(h, fields = {}) {
  post({ h, ...fields });
}

/** A bridge command that answers with {t:'reply', rid}. */
export function request(c, fields = {}, timeout = 15000) {
  const rid = `${BOOT}-${++ridSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(rid); reject(new Error(`${c} timed out`)); }, timeout);
    pending.set(rid, { resolve, reject, timer });
    send(c, { ...fields, rid });
  });
}

/** GET a music.163.com URL from NCM's page (its cookies, its session). */
export function ncmFetch(url) {
  return request('fetch', { url });
}

export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => handlers.get(type)?.delete(fn);
}

function emit(type, msg) {
  for (const fn of handlers.get(type) || []) {
    try { fn(msg); } catch (e) { console.error(`handler for ${type} failed`, e); }
  }
}

export function log(...args) {
  host('log', { msg: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') });
}

window.B = {
  receive(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'reply' && pending.has(msg.rid)) {
      const p = pending.get(msg.rid);
      pending.delete(msg.rid);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data); else p.reject(new Error(msg.error || 'failed'));
      return;
    }
    emit(msg.t, msg);
    emit('*', msg);
  },
};

// A page opened in a browser (no host): log instead of posting, so the files can be tried directly.
if (!window.webkit?.messageHandlers?.b) {
  window.webkit = { messageHandlers: { b: { postMessage: (m) => console.debug('[to host]', m) } } };
}

window.addEventListener('error', (e) => log('error:', String(e.message), e.filename || '', e.lineno || ''));
window.addEventListener('unhandledrejection', (e) => log('unhandled:', String(e.reason?.stack || e.reason)));
