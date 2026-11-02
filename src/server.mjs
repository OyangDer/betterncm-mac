// Local API server: v2's App.cpp routes, the sync native bridge, SSE callbacks and static mounts.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import {
  PROJECT_ROOT, BNCM_VERSION, MAC_VERSION, NCM_APP,
  getDataPath, readConfig, readConfigKey, writeConfigKey, getNcmVersion,
} from './config.mjs';
import { log } from './log.mjs';
import * as fsapi from './fsapi.mjs';

// The lyrics window's row in the plugin panel (not a plugin: config mac.lyricsWindow).
const LYRICS_WINDOW_SLUG = '@lyrics-window';
import { extractPackedPlugins, collectHijacks, listInstalledPlugins, setPluginEnabled } from './plugins.mjs';
import * as macos from './macos.mjs';

const ORPHEUS_ORIGIN = 'orpheus://orpheus';
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_BODY = 64 * 1024 * 1024;
const MAX_WATCHERS_PER_TARGET = 64;
const ORPHAN_WATCHER_MS = 30000; // a watcher whose document never opens its EventSource
// NCM's CEF drops an EventSource that stays silent for about 10 s (it then reconnects after its
// retry delay), so keep the stream busy, and let a dropped document reconnect before its
// watchers are disposed.
const SSE_PING_MS = 3000;
const SSE_RETRY_MS = 1000;
const RECONNECT_GRACE_MS = 10000;
const QUEUE_TTL_MS = 10000;
const SAFE_MODE_KEY = 'cc.microblock.betterncm.cpp_side_inject_feature_disabled';

// ---------- small helpers ----------

// The lyrics window's development routes run JS in its page and write files: only with
// mac.lyricsTest on (read per request), and snapshots only into the temp directories.
const lyricsDevOn = () => readConfigKey('mac.lyricsTest') === 'true';
function snapshotPath(p) {
  if (!path.isAbsolute(p) || !p.endsWith('.png')) return null;
  let dir;
  try { dir = fs.realpathSync(path.dirname(p)); } catch { return null; }
  const roots = new Set();
  for (const r of [os.tmpdir(), '/tmp']) { try { roots.add(fs.realpathSync(r)); } catch { /* none */ } }
  if (![...roots].some((r) => dir === r || dir.startsWith(r + '/'))) return null;
  const file = path.join(dir, path.basename(p));
  try { if (fs.lstatSync(file).isSymbolicLink()) return null; } catch { /* a new file */ }
  return file;
}

function randomString(n) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += chars[bytes[i] % chars.length];
  return s;
}

function keyMatches(given, apiKey) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(apiKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function setCommonHeaders(req, res) {
  if (req.headers.origin === ORPHEUS_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ORPHEUS_ORIGIN);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'BETTERNCM_API_KEY, Content-Type, X-BNCM-Target, X-BNCM-Context');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Cache-Control', 'no-store');
}

function send(res, status, body = '', type = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  if (body !== '' && body != null) res.setHeader('Content-Type', type);
  res.end(body ?? '');
}

function sendJson(res, value, status = 200) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function hostAllowed(req) {
  const host = req.headers.host;
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return ALLOWED_HOSTS.has(name.toLowerCase());
}

// Single-range static file responses (audio/video seeking needs Range).
function sendFile(req, res, file, mime) {
  let st;
  try {
    st = fs.statSync(file);
    if (st.isDirectory()) {
      file = path.join(file, 'index.html');
      st = fs.statSync(file);
    }
  } catch {
    send(res, 404, 'Not found');
    return;
  }
  if (!st.isFile()) {
    send(res, 404, 'Not found');
    return;
  }
  const size = st.size;
  res.setHeader('Content-Type', mime ?? fsapi.mimeOf(file));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Disposition', 'inline');
  let start = 0;
  let end = size - 1;
  const range = req.headers.range;
  if (range && size > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') {
        start = Math.max(0, size - Number(m[2]));
      } else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
      }
      if (start > end || start >= size) {
        res.setHeader('Content-Range', `bytes */${size}`);
        send(res, 416);
        return;
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    } else {
      res.statusCode = 200;
    }
  } else {
    res.statusCode = 200;
  }
  res.setHeader('Content-Length', size === 0 ? 0 : end - start + 1);
  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// Maps a URL path below a static root to a file, refusing any '..' segment.
function staticFile(root, relUrlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(relUrlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const segs = decoded.split(/[\\/]/).filter((s) => s.length > 0 && s !== '.');
  if (segs.includes('..')) return null;
  return { segs, file: path.join(root, ...segs) };
}

// /local must never expose the config, the run state (holds the API key) or the logs.
function localDenied(segs) {
  const first = (segs[0] ?? '').toLowerCase();
  return first === 'run' || first === 'log' || /^\.?config\.json/.test(first);
}

// ---------- native bridge table (v8NativeCalls.cpp) ----------

const S = 'std::string';
const N = 'double';
const CB = 'function';
const ANY = 'any';

function checkArgs(name, spec, args) {
  if (args.length < spec.length) {
    throw new Error(`Too few arguments. Expected ${spec.length} arguments, received ${args.length} arguments.`);
  }
  if (args.length > spec.length) {
    throw new Error(`Too many arguments. Expected ${spec.length} arguments, received ${args.length} arguments.`);
  }
  spec.forEach((t, i) => {
    const a = args[i];
    const ok = t === ANY
      || (t === S && typeof a === 'string')
      || (t === N && typeof a === 'number')
      || (t === CB && a && typeof a === 'object' && typeof a.$cb === 'string');
    if (!ok) throw new Error(`Invalid argument ${i}. Expected an ${t} but received a different type.`);
  });
}

// ---------- server ----------

export async function startServer({ apiKey, hooks = {} }) {
  if (typeof apiKey !== 'string' || apiKey.length < 16) throw new Error('startServer: apiKey required');

  const succeededHijacks = new Set();
  const mountedFiles = new Map(); // '/mounted_file/<id><ext>' -> absolute path
  const mountedDirs = new Map(); // '<id>' -> absolute dir
  const sse = new Map(); // targetId -> Set<res>
  const queued = new Map(); // targetId -> [{t, data}] callbacks sent before the EventSource connected
  // Watchers belong to one document (one frame's page load), keyed `${target}|${context}`, where the
  // context is the shim's per-document id (X-BNCM-Context header / ctx query). Keying them by target
  // alone loses the watchers of a reloaded page whenever the old page's EventSource closes late.
  const watchers = new Map(); // owner -> [dispose]
  const ownerConns = new Map(); // owner -> open SSE connections
  const orphanTimers = new Map(); // owner -> timer
  let port = 0;

  function sendToTarget(target, payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    const conns = sse.get(target);
    if (conns && conns.size) {
      for (const r of conns) r.write(data);
      return;
    }
    const q = (queued.get(target) ?? []).filter((e) => Date.now() - e.t < QUEUE_TTL_MS);
    if (q.length < 256) q.push({ t: Date.now(), data });
    queued.set(target, q);
  }

  function broadcast(targetId, payload) {
    if (targetId == null) {
      for (const t of new Set([...sse.keys()])) sendToTarget(t, payload);
    } else {
      sendToTarget(targetId, payload);
    }
  }

  function disposeWatchers(owner) {
    clearTimeout(orphanTimers.get(owner));
    orphanTimers.delete(owner);
    const list = watchers.get(owner);
    if (!list) return;
    watchers.delete(owner);
    for (const d of list) d();
  }

  function addWatcher(owner, dispose) {
    const list = watchers.get(owner) ?? [];
    list.push(dispose);
    while (list.length > MAX_WATCHERS_PER_TARGET) list.shift()();
    watchers.set(owner, list);
    // the EventSource normally connects within milliseconds; if it never does, nobody can receive
    if (!ownerConns.get(owner) && !orphanTimers.has(owner)) disposeLater(owner, ORPHAN_WATCHER_MS);
  }

  // Disposes the owner's watchers after `ms` unless one of its EventSources (re)connects first.
  function disposeLater(owner, ms) {
    clearTimeout(orphanTimers.get(owner));
    const t = setTimeout(() => {
      orphanTimers.delete(owner);
      if (!ownerConns.get(owner)) disposeWatchers(owner);
    }, ms);
    t.unref?.();
    orphanTimers.set(owner, t);
  }

  function makeCallback(target, id) {
    return (...args) => sendToTarget(target, { cb: id, args });
  }

  function emulatedCspIds() {
    if (readConfigKey('mac.bypassCSP', 'true') !== 'true') return [];
    if (readConfigKey(SAFE_MODE_KEY, 'false') === 'true') return [];
    let ver;
    try {
      ver = getNcmVersion();
    } catch {
      return [];
    }
    return collectHijacks(ver)
      .filter((h) => h.prefix.startsWith('orpheus://orpheus/app.html') && /Content-Security-Policy|script-src/.test(h.from ?? ''))
      .map((h) => `${h.slug}::${h.id}`);
  }

  // name -> [argSpec, fn(args, ctx)]; ctx = {target, cb(id), after(fn)}
  const NATIVE = {
    'test.add': [[N, N], ([a, b]) => a + b],
    'test.m.i.c.r.o.b.l.o.c.k': [[N, N], ([a, b]) => '🍊🍊🍊' + (a + b).toFixed(6)],
    'fs.readDir': [[S], ([p]) => fsapi.readDir(p)],
    'fs.readDirWithDetails': [[S], ([p]) => fsapi.readDirWithDetails(p)],
    'fs.getDisks': [[], () => fsapi.getDisks()],
    'fs.getLibraries': [[], () => fsapi.getLibraries()],
    'fs.readFileText': [[S], ([p]) => fsapi.readFileText(p)],
    'fs.readFileTextAsync': [[S, CB], ([p, cb], ctx) => {
      const fn = ctx.cb(cb.$cb);
      // like v2: unreadable files call back with ""
      ctx.after(() => Promise.resolve().then(() => fs.promises.readFile(fsapi.resolve(p), 'utf8')).catch(() => '').then((t) => fn(t)));
      return undefined;
    }],
    'fs.watchDirectory': [[S, CB], ([p, cb], ctx) => {
      addWatcher(ctx.owner, fsapi.watchDirectory(p, ctx.cb(cb.$cb)));
      return undefined;
    }],
    'fs.unzip': [[S, S], ([zip, dest]) => fsapi.unzip(zip, dest)],
    'fs.rename': [[S, S], ([a, b]) => fsapi.rename(a, b)],
    'fs.exists': [[S], ([p]) => fsapi.exists(p)],
    'fs.getProperties': [[S], ([p]) => fsapi.getProperties(p)],
    'fs.writeFileText': [[S, S], ([p, body]) => fsapi.writeFileText(p, body)],
    'fs.remove': [[S], ([p]) => fsapi.remove(p)],
    'app.auto_update': [[S], ([source], ctx) => {
      if (readConfigKey('mac.autoForceUpdate', 'false') === 'true') ctx.after(() => runAutoUpdate(source));
      return null;
    }],
    'app.reloadIgnoreCache': [[], () => true], // the shim reloads the page itself
    'app.datapath': [[], () => getDataPath()],
    'app.ncmpath': [[], () => NCM_APP + '/Contents/MacOS'],
    'app.version': [[], () => BNCM_VERSION],
    'app.restart': [[], (_a, ctx) => {
      ctx.after(() => hooks.onRestart?.());
      return true;
    }],
    'app.crash': [[], () => {
      throw new Error('not supported');
    }],
    'native_plugin.getRegisteredAPIs': [[], () => []],
    'native_plugin.call': [[S, ANY], () => {
      throw new Error('Invalid api id');
    }],
  };

  async function runAutoUpdate(source) {
    try {
      const m = await import('./autoupdate.mjs');
      const fn = m.autoUpdate ?? m.performForceInstallAndUpdate ?? m.default;
      if (typeof fn === 'function') await fn(source);
      else log('[native] autoupdate.mjs exports no updater');
    } catch (e) {
      log('[native] auto_update failed:', e.message);
    }
  }

  async function handleNative(req, res, name) {
    const after = [];
    let reply;
    try {
      const entry = Object.hasOwn(NATIVE, name) ? NATIVE[name] : null;
      if (!entry) throw new Error(`Unknown native API: ${name}`);
      const body = (await readBody(req)).toString('utf8');
      const args = body.trim() === '' ? [] : JSON.parse(body);
      if (!Array.isArray(args)) throw new Error('native call body must be a JSON array');
      checkArgs(name, entry[0], args);
      const target = req.headers['x-bncm-target'] ?? '';
      const ctx = {
        target,
        owner: `${target}|${req.headers['x-bncm-context'] ?? ''}`,
        cb: (id) => {
          if (!target) throw new Error('callbacks need the X-BNCM-Target header');
          return makeCallback(target, id);
        },
        after: (fn) => after.push(fn),
      };
      const value = await entry[1](args, ctx);
      reply = { ok: true, value: value === undefined ? null : value };
    } catch (e) {
      reply = { ok: false, error: e?.message ?? String(e) };
    }
    sendJson(res, reply);
    for (const fn of after) {
      setImmediate(() => {
        Promise.resolve().then(fn).catch((e) => log('[native] deferred action failed:', e.message));
      });
    }
  }

  function handleEvents(req, res, url) {
    const target = url.searchParams.get('target') ?? '';
    const owner = `${target}|${url.searchParams.get('ctx') ?? ''}`;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
    });
    res.write(`retry: ${SSE_RETRY_MS}\n: connected\n\n`);
    let set = sse.get(target);
    if (!set) sse.set(target, (set = new Set()));
    set.add(res);
    ownerConns.set(owner, (ownerConns.get(owner) ?? 0) + 1);
    clearTimeout(orphanTimers.get(owner));
    orphanTimers.delete(owner);
    const q = queued.get(target);
    queued.delete(target);
    for (const e of q ?? []) if (Date.now() - e.t < QUEUE_TTL_MS) res.write(e.data);
    const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS);
    res.on('close', () => {
      clearInterval(ping);
      set.delete(res);
      // The document went away (reload / close) or its stream dropped. Its watchers die with it,
      // like v2's "until the context dies", unless it reconnects within the grace period.
      const left = (ownerConns.get(owner) ?? 1) - 1;
      if (left > 0) ownerConns.set(owner, left);
      else {
        ownerConns.delete(owner);
        if (watchers.has(owner)) disposeLater(owner, RECONNECT_GRACE_MS);
      }
      if (set.size === 0) {
        sse.delete(target);
        queued.delete(target);
      }
    });
  }

  function mountUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
  }

  // GET routes under /api that take only query parameters.
  const GET = {
    '/fs/read_dir': (q, res) => sendJson(res, fsapi.readDir(q.get('path') ?? '')),
    '/fs/read_file_text': (q, res) => send(res, 200, fsapi.readFileBuffer(q.get('path') ?? ''), 'text/plain; charset=utf-8'),
    '/fs/read_file': (q, res) => send(res, 200, fsapi.readFileBuffer(q.get('path') ?? ''), 'application/octet-stream'),
    '/fs/mount_file': (q, res) => {
      const abs = fsapi.resolve(q.get('path') ?? '');
      const mp = '/mounted_file/' + randomString(48) + path.extname(abs);
      mountedFiles.set(mp, abs);
      send(res, 200, mountUrl(mp));
    },
    '/fs/mount_dir': (q, res) => {
      const abs = fsapi.resolve(q.get('path') ?? '');
      const id = randomString(48);
      mountedDirs.set(id, abs);
      send(res, 200, mountUrl('/mounted_dir/' + id));
    },
    '/fs/unzip_file': async (q, res) => send(res, 200, String(await fsapi.unzip(q.get('path') ?? '', q.get('dest') ?? ''))),
    '/fs/rename': (q, res) => {
      fsapi.rename(q.get('path') ?? '', q.get('dest') ?? '');
      send(res, 200, 'ok');
    },
    '/fs/mkdir': (q, res) => {
      fsapi.mkdir(q.get('path') ?? '');
      send(res, 200);
    },
    '/fs/exists': (q, res) => send(res, 200, fsapi.exists(q.get('path') ?? '') ? 'true' : 'false'),
    '/fs/remove': (q, res) => {
      fsapi.remove(q.get('path') ?? '');
      send(res, 200);
    },
    '/app/datapath': (_q, res) => send(res, 200, getDataPath()),
    '/app/ncmpath': (_q, res) => send(res, 200, NCM_APP + '/Contents/MacOS'),
    '/app/version': (_q, res) => send(res, 200, BNCM_VERSION),
    '/app/read_config': (q, res) => send(res, 200, String(readConfigKey(q.get('key') ?? '', q.get('default') ?? ''))),
    '/app/write_config': (q, res) => {
      const key = q.get('key') ?? '';
      // mac.* holds the exec/fs policy; page code must not be able to lift it.
      if (key.startsWith('mac.')) {
        throw Object.assign(new Error(`${key} can only be changed in config.json or from the command line`), { code: 'EBNCMDENIED' });
      }
      writeConfigKey(key, q.get('value') ?? '');
      send(res, 200);
    },
    // The injector's hook re-extracts and re-registers the injection (CONTRACT.md); without it we only extract.
    '/app/reload_plugin': async (_q, res) => {
      if (hooks.onReloadPlugin) await hooks.onReloadPlugin();
      else extractPackedPlugins();
      send(res, 200);
    },
    '/app/get_succeeded_hijacks': (_q, res) => sendJson(res, [...new Set([...succeededHijacks, ...emulatedCspIds()])]),
    '/app/show_console': (_q, res) => send(res, 200),
    '/app/set_rounded_corner': (_q, res) => send(res, 200),
    '/app/bg_screenshot': (_q, res) => send(res, 501, 'not supported on macOS'),
    '/app/is_light_theme': async (_q, res) => send(res, 200, (await macos.isLightTheme()) ? 'true' : 'false'),
    '/app/open_file_dialog': async (q, res) => send(res, 200, await macos.openFileDialog(q.get('filter') ?? '', q.get('initialDir') ?? '')),
    '/internal/framework.css': (_q, res) => {
      let css;
      try {
        css = fs.readFileSync(path.join(PROJECT_ROOT, 'dist', 'framework.css'));
      } catch {
        log('[server] dist/framework.css is missing');
        send(res, 404);
        return;
      }
      send(res, 200, css, 'text/css; charset=utf-8');
    },
    // The plugin panel in NCM's title bar (prelude/plugin-button.js). The lyrics window, which is
    // BetterNCM's own and replaces RefinedNowPlayingNext, comes first.
    '/internal/plugins': (_q, res) => {
      const installed = listInstalledPlugins();
      const rnpn = installed.some((p) => p.name === 'RefinedNowPlayingNext');
      sendJson(res, {
        version: MAC_VERSION,
        plugins: [
          { slug: LYRICS_WINDOW_SLUG, name: '歌词窗口', version: '', author: '', builtin: true, dev: false,
            description: `BetterNCM 自带的歌词页，关掉后改用${rnpn ? ' RefinedNowPlayingNext' : '网易云原版的播放页'}`,
            enabled: readConfigKey('mac.lyricsWindow') === 'true', note: '' },
          ...installed,
        ],
      });
    },
  };

  const POST = {
    '/fs/write_file_text': async (q, req, res) => {
      const body = await readBody(req, 512 * 1024 * 1024);
      fsapi.writeFileBuffer(q.get('path') ?? '', body);
      send(res, 200);
    },
    '/fs/write_file': async (q, req, res) => {
      const form = await new Request('http://127.0.0.1/', {
        method: 'POST',
        headers: { 'content-type': req.headers['content-type'] ?? '' },
        body: Readable.toWeb(req),
        duplex: 'half',
      }).formData();
      const file = form.get('file');
      if (file == null) {
        send(res, 400, 'missing multipart field "file"');
        return;
      }
      const buf = typeof file === 'string' ? Buffer.from(file, 'utf8') : Buffer.from(await file.arrayBuffer());
      fsapi.writeFileBuffer(q.get('path') ?? '', buf);
      send(res, 200);
    },
    '/app/exec': async (_q, req, res) => {
      const cmd = (await readBody(req)).toString('utf8');
      const r = await macos.execCommand(cmd, readConfig());
      send(res, r.status, r.status === 200 ? '' : r.message);
    },
    '/app/exec_ele': async (_q, _req, res) => send(res, 403, 'elevated exec is not supported on macOS'),
    '/internal/hijack_report': async (_q, req, res) => {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
      const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 1000) : [];
      for (const id of ids) succeededHijacks.add(id);
      hooks.onHijackReport?.(req.headers['x-bncm-target'] ?? '', ids);
      send(res, 200);
    },
    // Development: run JS in the lyrics window's page and return its value (LYRICS-WINDOW.md).
    '/internal/lyrics_eval': async (_q, req, res) => {
      if (!hooks.onLyricsEval || !lyricsDevOn()) { send(res, 404); return; }
      const js = (await readBody(req, 1024 * 1024)).toString('utf8');
      try {
        sendJson(res, { value: await hooks.onLyricsEval(js) });
      } catch (e) {
        send(res, 500, String(e?.message ?? e));
      }
    },
    '/internal/lyrics_snapshot': async (q, _req, res) => {
      if (!hooks.onLyricsSnapshot || !lyricsDevOn()) { send(res, 404); return; }
      const file = snapshotPath(q.get('path') ?? '');
      if (!file) { send(res, 403, 'snapshots go to a .png under the temp directory'); return; }
      try {
        sendJson(res, { value: await hooks.onLyricsSnapshot(file) });
      } catch (e) {
        send(res, 500, String(e?.message ?? e));
      }
    },
    // {slug, enabled}: takes effect when the plugins are extracted again (the panel then reloads the page)
    '/internal/plugins/enabled': async (_q, req, res) => {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
      if (typeof body.slug !== 'string' || typeof body.enabled !== 'boolean') { send(res, 400, 'need {slug, enabled}'); return; }
      // the one mac.* key the page may change: the injector's config watcher swaps the lyrics
      // window and RefinedNowPlayingNext and reloads the page itself
      if (body.slug === LYRICS_WINDOW_SLUG) {
        writeConfigKey('mac.lyricsWindow', String(body.enabled));
        send(res, 200);
        return;
      }
      setPluginEnabled(body.slug, body.enabled);
      if (hooks.onReloadPlugin) await hooks.onReloadPlugin();
      else extractPackedPlugins();
      send(res, 200);
    },
    // 卸载 BetterNCM in the plugin panel. Answered first: the uninstall stops this injector.
    '/internal/uninstall': async (_q, _req, res) => {
      if (!hooks.onUninstall) { send(res, 404); return; }
      send(res, 200);
      setTimeout(() => hooks.onUninstall(), 200);
    },
    '/internal/devtools': async (q, req, res) => {
      let target = req.headers['x-bncm-target'] ?? q.get('target') ?? '';
      const raw = (await readBody(req, 64 * 1024)).toString('utf8');
      if (!target && raw) {
        try {
          target = JSON.parse(raw).target ?? '';
        } catch {
          // not JSON
        }
      }
      await hooks.onDevtools?.(target);
      send(res, 200);
    },
  };

  async function handle(req, res) {
    setCommonHeaders(req, res);
    if (!hostAllowed(req)) {
      send(res, 403, 'Forbidden host');
      return;
    }
    if (req.method === 'OPTIONS') {
      send(res, 204);
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    if (p.startsWith('/api/')) {
      const route = p.slice(4);
      if (route === '/app/get_win_position' && req.method === 'GET') {
        sendJson(res, { x: 0, y: 0 });
        return;
      }
      if (route === '/events' && req.method === 'GET') {
        if (!keyMatches(url.searchParams.get('key') ?? req.headers.betterncm_api_key, apiKey)) {
          send(res, 401);
          return;
        }
        handleEvents(req, res, url);
        return;
      }
      if (!keyMatches(req.headers.betterncm_api_key, apiKey)) {
        send(res, 401);
        return;
      }
      if (route.startsWith('/native/') && req.method === 'POST') {
        await handleNative(req, res, decodeURIComponent(route.slice('/native/'.length)));
        return;
      }
      const getH = (req.method === 'GET' || req.method === 'HEAD') && Object.hasOwn(GET, route) ? GET[route] : null;
      const postH = req.method === 'POST' && Object.hasOwn(POST, route) ? POST[route] : null;
      if (!getH && !postH) {
        send(res, 404, 'Not found');
        return;
      }
      try {
        if (getH) await getH(url.searchParams, res);
        else await postH(url.searchParams, req, res);
      } catch (e) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        const status = e.code === 'EBNCMDENIED' ? 403 : e.status ?? 500;
        log(`[server] ${req.method} ${route} failed:`, e.message);
        send(res, status, e.message);
      }
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 404, 'Not found');
      return;
    }
    if (p.startsWith('/local/') || p === '/local') {
      const sf = staticFile(getDataPath(), p.slice('/local'.length));
      if (!sf || localDenied(sf.segs)) {
        send(res, 403, 'Forbidden');
        return;
      }
      sendFile(req, res, sf.file);
      return;
    }
    if (p.startsWith('/mounted_file/')) {
      let key;
      try {
        key = decodeURIComponent(p);
      } catch {
        key = p;
      }
      const file = mountedFiles.get(key) ?? mountedFiles.get(p);
      if (!file) send(res, 404, 'Not found');
      else sendFile(req, res, file);
      return;
    }
    const md = /^\/mounted_dir\/([A-Za-z0-9]{48})(\/.*)?$/.exec(p);
    if (md && mountedDirs.has(md[1])) {
      const sf = staticFile(mountedDirs.get(md[1]), md[2] ?? '/');
      if (!sf) send(res, 403, 'Forbidden');
      else sendFile(req, res, sf.file);
      return;
    }
    send(res, 404, 'Not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('[server] unhandled error:', e.message);
      if (!res.headersSent) send(res, 500, e.message);
      else res.destroy();
    });
  });
  server.requestTimeout = 0; // large plugin uploads and long-lived SSE
  server.headersTimeout = 60000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = server.address().port;
  log(`[server] listening on 127.0.0.1:${port}`);

  return {
    port,
    broadcast,
    close() {
      for (const t of [...watchers.keys()]) disposeWatchers(t);
      for (const t of orphanTimers.values()) clearTimeout(t);
      orphanTimers.clear();
      for (const set of sse.values()) for (const r of set) r.end();
      sse.clear();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
