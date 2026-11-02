# betterncm-mac module contract

The design is in `DESIGN.md` (read sections 1–4 and 6). This file pins down the interfaces between modules, so that the modules can be written in parallel. When `DESIGN.md` and this file disagree, this file wins.

## General rules

- Node >= 22 (v24 is installed), ESM only (`.mjs`), no TypeScript.
- Runtime dependencies: only `semver`, vendored in `vendor/semver/` so a clone runs without `npm install`. Use Node built-ins for everything else (`node:http`, `node:fs`, `node:child_process`, global `WebSocket` and `fetch`).
- Use `/usr/bin/unzip` to work with zip files.
- Never modify `/Applications/NeteaseMusic.app`.
- Log with `log(...)` from `src/log.mjs`.

## src/log.mjs (owner: core)

```js
export function log(...a)   // writes to stderr with an ISO timestamp, and appends to <datapath>/log/injector.log once setLogFile() has been called
export function setLogFile(path)
```

## src/config.mjs (owner: core)

```js
export const NCM_APP                            // BNCM_NCM_APP || config mac.ncmApp || /Applications or ~/Applications/NeteaseMusic.app || Spotlight by bundle id; else /Applications/NeteaseMusic.app
export const BUNDLE_ID = 'com.netease.163music'
export const TESTED_NCM = '3.1.x'               // semver range; TESTED_NCM_LABEL = '3.1.14'
export function ncmSupport(ver)                 // -> 'ok' | 'untested' (other 3.x: one warning dialog per version) | 'unsupported' (< 3: refused)
export const BNCM_VERSION = '1.3.4'            // the version the framework reports
export const MAC_VERSION = '0.1.0'             // betterncm-mac version
export const PROJECT_ROOT                       // absolute path of the betterncm-mac/ dir (from import.meta.url)
export function getDataPath()                   // process.env.BETTERNCM_PROFILE || ~/Library/Application Support/BetterNCM-mac ; no trailing slash
export function ensureDataDirs()                // creates plugins/ plugins_runtime/ plugins_dev/ log/ run/
export function readConfig()                    // -> object (flat string->string) from <datapath>/config.json, {} if missing
export function readConfigKey(key, def)         // -> string
export function writeConfigKey(key, value)      // atomic write (tmp + rename); a config.json that does not parse is copied to config.json.broken-<ms> first
export function getNcmVersion()                 // reads CFBundleShortVersionString from NCM_APP Info.plist each call (via `defaults read` or plutil) -> '3.1.14'
export function getNcmBuild()                   // CFBundleVersion -> '3459'
```

Mac-only config keys, with these defaults:

| Key | Default |
|---|---|
| `mac.cdpPort` | `'9222'` |
| `mac.bypassCSP` | `'true'` |
| `mac.channelShim` | `'true'` |
| `mac.allowExec` | `'false'` |
| `mac.allowFsOutsideData` | `'false'` |
| `mac.autoForceUpdate` | `'false'` |
| `mac.rnpAppleStyle` | `'true'` (runs `compat-rnp-layout.js`, `compat-rnp-cover.js`, `compat-rnp-top-controls.js`) |
| `mac.stopMiniVinyl` | `'false'` (runs `stop-mini-vinyl.js`) |
| `mac.rnpAutoLyricSize` | `'true'` (runs `compat-rnp-lyric-size.js`) |
| `mac.pluginManager` | `'false'` (not `'true'`: runs `hide-plugin-manager.js`; PluginMarket is neither seeded nor loaded) |

Not in the defaults (so not in `__BNCM_CFG__`): `mac.ncmApp` (NCM bundle path), `mac.warnedNcmVersion` (last untested version warned about). (`mac.seeded.RefinedNowPlayingNext` may still be in older data dirs; nothing reads it since RefinedNowPlayingNext stopped being bundled.)

## src/fsapi.mjs (owner: server)

```js
export function resolve(p)                      // section 1.5 of DESIGN.md
export function readDir(p) / readDirWithDetails(p) / readFileText(p) / exists(p) / getProperties(p)
export function writeFileText(p, text) / writeFileBuffer(p, buf) / remove(p) / rename(a, b) / mkdir(p)
export async function unzip(zip, dest)          // -> exit code
export function watchDirectory(p, onEvent)      // onEvent(dir, relFilename); returns a dispose() function
export function getDisks() / getLibraries()
export function mimeOf(path)
```

## src/zip.mjs (owner: server)

```js
listEntries(zip), readEntry(zip, name) -> Buffer, extractAll(zip, dest)
```

`extractAll` rejects archives that have `..` or absolute entries.

## src/plugins.mjs (owner: server)

```js
export function slugOf(name)
export function seedPluginMarket()              // copies PROJECT_ROOT/resources/PluginMarket.plugin into <datapath>/plugins/ if it is missing or older than 0.7.2
export function extractPackedPlugins()          // sync; DESIGN.md section 4; returns {loaded:[slug], skipped:[{file, reason}]}
export function getAllPlugins()                 // -> [{slug, path (absolute dir), manifest, dev:boolean}] from plugins_runtime + plugins_dev
export function collectHijacks(ncmVer)          // -> [{slug, id, prefix, type, from, to, code}] (with the app.html prefix remap)
export function collectStartupScripts()         // -> [{slug, code}] from manifest.startup_script / startup_script.js, if v2 supports that (check bncm-v2 App.cpp)
```

## src/server.mjs (owner: server)

```js
export async function startServer({ apiKey, hooks })  // listens on 127.0.0.1:0 -> { port, close(), broadcast(targetId|null, payload) }
// hooks = {
//   onReloadPlugin: async () => {},          // injector re-registers its injections; the server awaits this before replying
//   onRestart: async () => {},
//   onDevtools: async (targetId) => {},
//   onHijackReport: (targetId, ids) => {},
// }
```

Routes:
- Every route in DESIGN.md section 2b.
- `POST /api/native/<dotted.name>`: the sync bridge from section 1.4. Async results are not allowed; the handler must answer immediately.
- `GET /api/events?key=&target=`: SSE.
- `GET /api/internal/framework.css`: serves `PROJECT_ROOT/dist/framework.css`.

Callbacks: when a native argument is `{"$cb":"<id>"}`, the server sends `{cb, args}` over the SSE connection for the target given in the `X-BNCM-Target` request header.

## src/macos.mjs (owner: server)

```js
openTarget(urlOrPath), execCommand(cmdline, cfg), isLightTheme(), openFileDialog(filter, initialDir), openDevtools(port, targetId)
```

## src/prelude/*.js (owner: prelude)

These are plain browser scripts, concatenated by `bundle.mjs` (each one is wrapped in its own IIFE). They read the lexical consts `BETTERNCM_API_KEY`, `BETTERNCM_API_PORT`, `BETTERNCM_API_PATH`, `BETTERNCM_FILES_PATH`, `__BNCM_TARGET__`, `__BNCM_HIJACKS__`, `__BNCM_SAFE__`, `__BNCM_CFG__` (an object of mac.* keys).

| File | Installs |
|---|---|
| `polyfills.js` | `Event.prototype.path` |
| `native-shim.js` | `window.betterncm_native` (it sends the `X-BNCM-Target: __BNCM_TARGET__` header). It also sets `const`-style globals so that the framework's bare `betterncm_native` references resolve; a `window` property is enough. |
| `hijack-runtime.js` | Uses the MutationObserver technique that M0 verified (`n.removeAttribute('src'); n.text = transformed + sourceURL`) plus `appendChild`/`insertBefore` wrappers. Reports to `POST /api/internal/hijack_report` with body `{ids:[...]}`. |
| `channel-shim.js` | Only when `__BNCM_CFG__['mac.channelShim']==='true'`. |
| `devtools-key.js` | Opens DevTools on a key press. |

## src/bundle.mjs (owner: core)

```js
export function buildInjection({ targetId, apiKey, apiPort, safe, cfg, hijacks, startupScripts })  // -> string
```

Layout follows DESIGN.md section 1.3. It reads `src/prelude/*.js` and `dist/framework.js` from disk on every call.

## src/injector.mjs, src/cdp.mjs, src/launcher.mjs, bin/bncm-mac.mjs (owner: core)

CLI commands:

| Command | What it does |
|---|---|
| `launch [--daemon]` | Finds or launches NCM with the CDP port, starts the server, attaches, injects, and stays running. |
| `attach [--port N]` | The same, but never launches or quits NCM. |
| `doctor` | Prints NCM version, ports, targets, data dir and plugin decisions. |
| `install-app [--dock]` / `uninstall-app` | Install or remove the wrapper app (localized name 网易云音乐 BetterNCM / NetEaseMusic BetterNCM); `--dock` pins it via `src/dock.mjs`, removal unpins it. |
| `uninstall [--purge]` | Stop the injector (SIGTERM), remove the wrapper, with `--purge` delete the data dir if it looks like ours. |
| `reload` | Calls the running instance's API, using `run/state.json`, which holds the key. |

Injector startup sequence:
1. `ensureDataDirs`
2. `seedPluginMarket`
3. `extractPackedPlugins`
4. random 64-character apiKey
5. `startServer`
6. CDP attach
7. per page session: `Page.enable`, `Runtime.enable`, `setBypassCSP`, `addScriptToEvaluateOnNewDocument(buildInjection)`, then reload if `typeof betterncm !== 'object'`

When `onReloadPlugin` fires: `extractPackedPlugins`, then rebuild the injection for every session (remove the old script, add the new one).

Before step 2 the injector claims the data dir with `run/injector.lock` (`open wx`, pid inside; a dead owner's lock is taken over) and writes `run/state.json` as `{injectorPid, mode, startedAt, starting: true}`; the full state follows once the ports are known. A state without `apiPort` means "injector starting": `reload`/`doctor` neither call the API nor touch `plugins_runtime`.

On exit, remove `run/state.json`; only the lock holder removes `plugins_runtime/*`, then releases the lock.

## framework/ (owner: framework)

- Vendored js-framework@44b4df2 with patches F1–F13 (DESIGN.md section 3), kept as `patches/js-framework-mac.patch`.
- `npm run build` (in `framework/`) writes `../dist/framework.js` and `../dist/framework.css`. Install esbuild locally as a devDependency.
- Before any framework code runs, the framework fetches CSS from `BETTERNCM_API_PATH + '/internal/framework.css'`. Keep that behaviour.
