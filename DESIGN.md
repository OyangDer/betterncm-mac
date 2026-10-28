# BetterNCM II on macOS NetEase 3.1.14 via CDP: port design

## 0. New facts from live probes

I ran four probes against the running app (pid 4461, CDP 127.0.0.1:9222). Each paused request was continued and each session was detached; the page stayed responsive. The scripts are in `/tmp/scratch` (`fetchtest.mjs`, `dbgtest.mjs`, `srv.mjs`).

| ID | Finding | Consequence |
|---|---|---|
| P1 | CDP `Fetch.enable({patterns:[{urlPattern:"orpheus://*",requestStage:"Response"}]})` succeeds, but a page `fetch('orpheus://orpheus/pub/hybrid/0.chunk…js')` returned 200 with **zero** `Fetch.requestPaused` events. | CDP Fetch does not see CEF custom-scheme loads. **Hijacks cannot use the Fetch domain.** |
| P2 | `Debugger.setInstrumentationBreakpoint('beforeScriptExecution')` pauses correctly. `Debugger.setScriptSource` on the paused, not-yet-run script **never answers** (it hangs until detach). | The Debugger route for hijacks is not viable. |
| P3 | A **synchronous XHR** from the page works to `orpheus://…` (200, 53232 bytes). It also works to `http://127.0.0.1:47123` and `http://localhost:47123` with the custom header `BETTERNCM_API_KEY`: 200, `Origin: orpheus://orpheus`, and **no OPTIONS preflight was sent**. The server still answers OPTIONS in case. | A sync-XHR bridge for `betterncm_native.*` is confirmed. |
| P4 | `app.html` static scripts, in order: inline, inline, async inline, `./vendor/@cloudmusic-desktop/vendors-rudio…js`, inline, then `/pub/hybrid/vendors~app~subApp.chunk.18d435e.js`, `/pub/hybrid/vendors~app.chunk…`, `/pub/hybrid/0.chunk…`, `/pub/hybrid/7.chunk…`, `/pub/hybrid/app.chunk…`. The others load dynamically as `orpheus://orpheus/pub/hybrid/<n>.chunk.18d435e.js`. `app.bundle…js` comes from `https://s6.music.126.net`. In `webfiles.zip`, the URL `/pub/X` maps to the zip root `X`. `sagaEffects.put"),` is in `hybrid/vendors~app~subApp.chunk.18d435e.js`. | Plugin hijack prefixes such as `orpheus://orpheus/pub/hybrid/vendors` and `…/pub/core` **match unchanged**. Only `orpheus://orpheus/pub/app.html` needs remapping to `orpheus://orpheus/app.html`. |
| P5 | `/json/version` exposes a browser endpoint `ws://127.0.0.1:9222/devtools/browser/<uuid>`. `lsof` shows the debug port bound to **127.0.0.1** only. NCM also listens on 127.0.0.1:20017 (its own). The running instance was started as `/Applications/NeteaseMusic.app/Contents/MacOS/NeteaseMusic --remote-debugging-port=9222 --remote-allow-origins=http://127.0.0.1:9222`. Bundle id is `com.netease.163music`, `CFBundleShortVersionString` 3.1.14, and Sparkle auto-update is present. | |
| P6 | Node v24.22.0 is installed and has global `WebSocket`, `fetch`, and `Request.formData()`. | The injector can have zero runtime dependencies apart from `semver`. Zip handling uses `/usr/bin/unzip`. |
| P7 | `mmbncm` (Steve-xmh, 2024-11) is a Rust dylib that is inserted into the binary (`insert_dylib`, `unsign.py`) and targets the old WKWebView. | It is not reusable here, since we do not patch the app. |

---

## 1. Architecture

```
BetterNCM.app (wrapper, ~/Applications) ──exec──> node bin/bncm-mac.mjs launch
   launcher ──open -a NeteaseMusic --args --remote-debugging-port=P──> NCM (CEF 116)
   injector ──ws browser endpoint (flatten sessions)──> every orpheus:// page target
   api server  http://127.0.0.1:<A>/api/*  /local/*  /mounted_*/*  /api/events (SSE)
        ^ sync XHR (betterncm_native shim), fetch (betterncm.* API), EventSource (callbacks)
   page: [prelude: polyfills + consts + native shim + channel shim + hijack runtime] + framework.js + startup scripts
```

### 1.1 Launcher (`src/launcher.mjs`)

**Ports.**
- CDP port: config `cdpPort`, default **9222**. Use the same fixed port so users and tools find it. If it is busy with a non-NCM process, take a random free port (listen on 0 and read the port back).
- API port: a fresh random ephemeral port on 127.0.0.1 each time the injector starts (same as v2's `bind_to_any_port`).
- Write `datapath/run/state.json` = `{cdpPort, apiPort, ncmPid, injectorPid, startedAt}`.

**Detect a running NCM:** `pgrep -x NeteaseMusic`, then read its arguments with `ps -o args= -p <pid>`.

**If NCM is running:**
- With `--remote-debugging-port=N`: attach to N.
- Without it: show `osascript display dialog "NetEase is running without BetterNCM. Restart it?"`. On OK:
  1. Quit gracefully with `osascript -e 'tell application id "com.netease.163music" to quit'`.
  2. Poll `pgrep` for up to 15 s.
  3. Relaunch. Never send SIGKILL unless the user confirms.

**Launch:** `open -a /Applications/NeteaseMusic.app --args --remote-debugging-port=P --remote-allow-origins=http://127.0.0.1:P`.
- `open` (LaunchServices) gives normal Dock and activation behaviour.
- `--args` only takes effect on a fresh launch, which the check above guarantees.
- Do not pass `--disable-web-security`; it is not needed (P3).

**Wait for CDP:** poll `http://127.0.0.1:P/json/version` every 100 ms, with a 30 s timeout.

**Wrapper app:** the `install-app` command writes `~/Applications/BetterNCM.app`.
- `Contents/Info.plist`: `LSUIElement=1` (no Dock icon) and `CFBundleIdentifier=cc.microblock.betterncm-mac`.
- `Contents/MacOS/BetterNCM`: a bash script that runs `exec "<abs node>" "<project>/bin/bncm-mac.mjs" launch --daemon >> "$DATA/log/injector.log" 2>&1`.
- The user keeps BetterNCM.app in the Dock instead of NCM.
- The injector exits when the browser websocket closes and NCM's pid is gone. It is not a LaunchAgent: a LaunchAgent cannot add flags to a NCM launched from the Dock, so it adds nothing.

**Security note:** any local process can drive NCM over the CDP port, which includes access to cookies and the account. Document this.
- Optional hardening (open question Q6): `--remote-debugging-pipe` with the binary spawned directly and fds 3 and 4. Whether CEF 116 honours that switch is unverified.

### 1.2 Injector (`src/injector.mjs`, `src/cdp.mjs`)

**Connection and targets.**
- Connect to the **browser** websocket from `/json/version`. Use flattened sessions (`sessionId` on every message).
- `Target.setDiscoverTargets({discover:true})`.
- `Target.setAutoAttach({autoAttach:true, waitForDebuggerOnStart:true, flatten:true})`.
  - For new targets: run setup, then `Runtime.runIfWaitingForDebugger`.
  - For targets that already exist (`Target.getTargets`, type `page`, URL starting with `orpheus://`): `Target.attachToTarget({targetId, flatten:true})`, run setup, then `Page.reload()`.
    - At cold start the main window is almost always already loading, so expect one reload.
    - Reload only if `Runtime.evaluate('typeof betterncm')` is not `"object"`. That avoids a reload when the injector restarts.

**Per-session setup:**
1. `Page.enable`, `Runtime.enable`.
2. `Page.setBypassCSP({enabled: cfg.bypassCSP ?? true})`. This stands in for AMLL's app.html CSP hijack.
3. `id = Page.addScriptToEvaluateOnNewDocument({source: buildInjection(targetId)})`. Store `id` per session.

**Re-injection:** on `GET /api/app/reload_plugin` and on config changes, rebuild the injection for every session (`Page.removeScriptToEvaluateOnNewDocument(old)` then add the new one) **before** responding. The framework calls `reloadPlugins()` and then reloads the page, so the next load sees fresh plugins, startup scripts and hijacks. This is better than v2, whose startup scripts and hijacks stay stale until restart.

**No late `Runtime.evaluate` injection.** The framework depends on `DOMContentLoaded`, the native shim and the hijack runtime, which only work at document start. Always reload instead.

**Reconnect.**
- If the browser websocket closes and the NCM pid is alive: retry every 1 s.
- If the pid is gone: exit, or relaunch when `restart` was requested.
- `Target.targetDestroyed` and `detachedFromTarget`: drop the session.
- Navigations inside a session keep the registered script, so no action is needed.

**DevTools key** (replaces v2's F12): the prelude adds a `keydown` listener for F12 / Cmd-Opt-I that calls `POST /api/internal/devtools`. Node then runs `open "http://127.0.0.1:P/devtools/inspector.html?ws=127.0.0.1:P/devtools/page/<targetId>"`. Open question Q7: whether CEF serves the frontend at that path; the fallback is `chrome://inspect`.

### 1.3 Injection script layout (`src/bundle.mjs` builds one string per target)

```js
// 1. polyfills (all orpheus frames)
if (!('path' in Event.prototype)) Object.defineProperty(Event.prototype,'path',{get(){return this.composedPath()},configurable:true});
// 2. consts (top-level const, like App.cpp:569-585; unconditional)
const BETTERNCM_API_KEY='<64>', BETTERNCM_API_PORT=<A>, BETTERNCM_API_PATH='http://127.0.0.1:<A>/api', BETTERNCM_FILES_PATH='http://127.0.0.1:<A>/local';
const __BNCM_TARGET__='<targetId>', __BNCM_HIJACKS__=<json of active hijacks>, __BNCM_SAFE__=<bool>;
// 3. if (location.protocol==='orpheus:') { native shim; hijack runtime (unless safe) }
// 4. if (window===top && location.protocol==='orpheus:') { channel shim; <framework.js IIFE>; startup scripts (unless safe), each wrapped in try{}catch + //# sourceURL=file://<slug>/startup_script.js }
```

- Use `127.0.0.1`, not `localhost`, so there are no IPv6 or DNS surprises. Both work (P3).
- Do not inject v2's `fix_window_position.js` or `fix_nav_disappear.js`: both target Windows / NCM 2.x.
- Do not inject the `auto_update` snippet by default (see §4).

### 1.4 Native bridge wire protocol (`src/prelude/native-shim.js`, `src/server.mjs`)

**Sync request**
- `POST /api/native/<dotted.name>`
- Headers: `BETTERNCM_API_KEY: <key>`, `Content-Type: application/json`
- Body: JSON array of the arguments.
- Response: `200 {"ok":true,"value":<any>}` or `200 {"ok":false,"error":"<msg>"}`.

**Shim**
```js
function call(name, args, arity) {
  if (args.length !== arity) throw new Error(args.length < arity ? 'Too few arguments' : 'Too many arguments');
  const x = new XMLHttpRequest();
  x.open('POST', BETTERNCM_API_PATH + '/native/' + name, false);
  x.setRequestHeader('BETTERNCM_API_KEY', BETTERNCM_API_KEY);
  x.setRequestHeader('Content-Type', 'application/json');
  x.send(JSON.stringify(args.map(enc)));
  const r = JSON.parse(x.responseText);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
```

**Callbacks**
- `enc(fn)` registers `fn` in `__bncmCb[id]` and sends `{"$cb":"<id>"}`.
- Callbacks are delivered over **SSE** at `GET /api/events?key=<key>&target=<id>`. EventSource cannot send headers, so the key goes in the query.
- The EventSource opens lazily on first use. Each message is `{"cb":"<id>","args":[...]}`, dispatched with `__bncmCb[id](...args)`.
- On reload the EventSource closes; the server then disposes the watchers for that connection, which matches v2's "until the context dies".

`window.betterncm_native` is built as a nested object of stubs with exact arities, matching v8NativeCalls.cpp. It is installed only if absent.

### 1.5 Data directory

Default `~/Library/Application Support/BetterNCM-mac/`, overridable with the env var `BETTERNCM_PROFILE` (same name as v2).

```
plugins/            *.plugin (PluginMarket.plugin seeded from bncm-v2/resource/PluginMarket.plugin if missing)
plugins_runtime/<slug>/ (+ .plugin.path.meta)   wiped/rebuilt at injector start + reload_plugin; deleted on clean exit
plugins_dev/<dir>/
config.json          flat string->string
disable_list.txt
PLUGIN_EXTRACTING_LOCK.lock
run/state.json   log/injector.log   log/log.log
```

**Path resolver** (`src/fsapi.mjs: resolve(p)`), the macOS version of `path[1]==':'`:
1. Replace `\` with `/`.
2. If the path starts with datapath, use it as is.
3. If it matches `^[A-Za-z]:`, throw `"Windows path not supported"`.
4. If it starts with `/`:
   - If the first segment exists at the filesystem root (`fs.existsSync('/'+seg)`: `/Users`, `/Volumes`, `/private`, `/tmp`, `/Applications`, …), it is absolute.
   - Otherwise it is `datapath + p`. This keeps `.plugin.path.meta` = `/plugins/X.plugin` and the tests' `/__TEST_*.txt` working.
5. Otherwise it is `datapath + '/' + p`, **without normalizing**.
   - `readDir` returns `dir + '/' + name`, so `"./plugins_dev"` yields `<datapath>/./plugins_dev/Foo`. That keeps `pluginPath.includes("./plugins_dev")` in plugin-manager/index.tsx:213 working.

---

## 2. Native API mapping

Priority: **M** = must (framework or PluginMarket breaks without it), **S** = should (used by common NCM3 plugins), **C** = can-skip or stub.

### 2a. Sync `betterncm_native.*` (bridge: `/api/native/<name>`)

| API (arity) | Mac implementation | Pri |
|---|---|---|
| `fs.readDir(1)` | `readdirSync(resolve(p))` mapped to `rawDir + '/' + name`. Throw if missing. Keep `readdir` order (no sort). | M |
| `fs.readFileText(1)` | `readFileSync(utf8)`. Missing file returns `""` (no throw). | M |
| `fs.exists(1)` | `existsSync` | M |
| `fs.watchDirectory(2)` | `fs.watch(resolve(p), {recursive:true})` (FSEvents). Per event, `cb(dir, relFilename)` over SSE. Debounce 50 ms per file. | M (dev plugins only; a stub would break nothing at startup) |
| `app.version(0)` | `"1.3.4"`. Hard-code it in the shim; no XHR, because it is called during render. | M |
| `app.reloadIgnoreCache(0)` | Shim: `setTimeout(()=>location.reload())` and return `true`. No server call, since the API server sends `Cache-Control: no-store`. | M |
| `app.restart(0)` | Server responds `true`, then: graceful quit, wait for exit, relaunch with the same flags, re-attach. The injector is the parent process and survives. | M |
| `fs.getProperties(1)` | `lstatSync`, returning `{name, path: dirname, size (0 for dirs), type, extension ('.x'), lastModified: mtimeMs + 11644473600000, hidden: name.startsWith('.'), system: false}` | M (remover.js) |
| `fs.readDirWithDetails(1)` | As above, per entry | S |
| `fs.readFileTextAsync(2)` | Shim only: async `fetch` to `/api/fs/read_file_text`, then `cb(text)` | S |
| `fs.writeFileText(2)` | `writeFileSync`, create parent directories, return `true` | S |
| `fs.remove(1)` | `rmSync({recursive:true, force:true})`, return `true`. Refuse anything outside datapath unless `cfg.allowFsOutsideData`. | S |
| `fs.unzip(2)` | `execFile('/usr/bin/unzip', ['-o', '-q', zip, '-d', dest])`. Return the exit code (0 = OK). | S |
| `fs.rename(2)` | `renameSync`, return `true`. The single-argument variant throws "Too few arguments", same as v2. | S |
| `app.datapath(0)` / `app.ncmpath(0)` | datapath / `/Applications/NeteaseMusic.app/Contents/MacOS` | S |
| `fs.getDisks(0)` | `/Volumes/*` with `statfsSync`, returned as `{disk: '/Volumes/X', name, used, size}` | C |
| `fs.getLibraries(0)` | `~/Desktop, Downloads, Documents, Pictures, Music, Movies`, with v2's names | C |
| `app.auto_update(1)` | Stub that returns `null`. Runs the real routine only if `cfg.autoForceUpdate==="true"` (§4). | C |
| `app.crash(0)` | Throws `"not supported"` | C |
| `test.add(2)` | `a+b` (shim-local) | C |
| `native_plugin.getRegisteredAPIs(0)` | `[]` | C |
| `native_plugin.call(2)` | Throws `"Invalid api id"` | C |

### 2b. Async HTTP API (`/api/*`; every route requires the key header except OPTIONS)

**Headers on every response:**
- `Access-Control-Allow-Origin`: echo the request `Origin` if it is `orpheus://orpheus`. Send nothing for any other origin, so web pages in other browsers cannot read the API.
- `Access-Control-Allow-Headers: BETTERNCM_API_KEY, Content-Type`
- `Access-Control-Allow-Methods: GET, POST, OPTIONS`
- `Access-Control-Allow-Private-Network: true`
- `Cache-Control: no-store`

OPTIONS returns 204. A wrong key returns 401.

| Route | Mac implementation | Pri |
|---|---|---|
| `GET /internal/framework.css` | Serve `dist/framework.css` as text/css | M |
| `GET fs/read_dir`, `fs/read_file_text`, `fs/exists` (`"true"`/`"false"`) | Same as the native versions | M |
| `GET fs/read_file` | octet-stream | S |
| `POST fs/write_file?path=` | `await new Request('http://x', {method:'POST', headers, body: req, duplex:'half'}).formData()`, then `.get('file')`, then `arrayBuffer`, then write. Create parent directories. | M (market install) |
| `POST fs/write_file_text?path=` | Raw body, then write | S |
| `GET fs/mkdir`, `fs/remove`, `fs/rename`, `fs/unzip_file` | As in 2a | M (remove), S (others) |
| `GET fs/mount_file` | Registers `/mounted_file/<rand48><ext>`, served with Range support and MIME from extension (extend v2's table: webp, svg, mp4, woff2, json). No key on the mounted URL. Returns `http://127.0.0.1:A/mounted_file/…`. | S (BGEnhanced) |
| `GET fs/mount_dir` | `/mounted_dir/<rand48>/*` static, with traversal guard | S |
| `GET app/version` | `1.3.4` | M |
| `GET app/read_config`, `app/write_config` | config.json, with atomic write (tmp + rename) | M |
| `GET app/reload_plugin` | `extractPackedPlugins()`, then re-register injections (§1.2), then 200 | M |
| `GET app/datapath` / `app/ncmpath` | strings | S |
| `GET app/get_succeeded_hijacks` | Union of the `slug::id` reports from the page (`POST /internal/hijack_report`), plus emulated CSP ids | S |
| `POST app/exec` | Parse argv as shell words. Allowed cases: (a) `argv[0]` is `http(s)://` → `open <url>`; (b) `argv[0]` is `explorer` (case-insensitive) → `open <resolve(argv[1])>`; (c) `argv[0]` is an existing file or directory → `open <path>`. Anything else returns 403 unless `cfg.allowExec==="true"` (then `execFile(argv[0], rest)`). | S (market links, open folder) |
| `POST app/exec_ele` | 403 | C |
| `GET app/is_light_theme` | `defaults read -g AppleInterfaceStyle`: `"Dark"` gives false, an error gives true | S |
| `GET app/open_file_dialog` | `osascript -e 'POSIX path of (choose file default location POSIX file "<initialDir>" of type {<exts parsed from Win filter "*.png;*.jpg">})'`. Cancel returns `""`. | S (BGEnhanced) |
| `GET app/show_console` | Opens DevTools (§1.2) or no-op; returns 200 | C |
| `GET app/set_rounded_corner` | No-op, 200 | C |
| `GET app/bg_screenshot` | 501. Optional later: `screencapture -x -t png` (needs Screen Recording permission) | C |
| `GET app/get_win_position` (no key) | `{"x":0,"y":0}` | C |
| `GET /local/*` (no key) | Static datapath with traversal guard. Never serve `config.json` or `run/`. | S |
| `GET /api/events` | SSE (§1.4) | M (if watchDirectory is implemented) |

### 2c. NCM-side shims (page, `src/prelude/channel-shim.js`)

**`window.channel = { call(cmd, cb, params), registerCall(evt, cb), removeRegisterCall(evt, cb), viewCall: undefined }`**
- `call`:
  1. `seq = "::[[bncm]]::" + n`
  2. `window.$$MNBCallbackMap[seq] = {type: "call", source: "bncm", callback: cb || (()=>{})}`
  3. `ncmChannelOSX.postMessage({method: "call", command: cmd, params: params || [], seq})`
- `registerCall`: the same with `type: "registerCall"` and `{method: "registerCall", command: evt, seq}`.
- Install it inside `DOMContentLoaded` (capture, before the framework's listener runs). At that point NCM's parser-blocking bundles have already run, so their boot-time feature detection does not see it. Gate it with `cfg.channelShim` (default on).
- Open question Q3 covers the side effects and the map shape.

**`ncm.getPlayingSong` fallback:** in the framework patch (§3), read from the dva store.

---

## 3. js-framework changes and build

Vendor FW@44b4df2 into `framework/` and keep the changes as `patches/js-framework-mac.patch`. Rule: patch only what the prelude cannot polyfill.

| # | File:line | Change |
|---|---|---|
| F1 | `src/loader.ts:140-143` | `pageMap = {"/pub/app.html":"Main", "/app.html":"Main"}`. **Blocker.** |
| F2 | `src/plugin-manager/index.tsx:13-14` | `mainPageView = waitForElement('[data-testid=tid_scroll_container], .right-container, section.g-mn')`. That is `div.AppScrollContainer_*`, the whole right pane under the 80 px header. Insert the panel as its sibling. Style it from `mainPageView`'s `offsetTop/Left/Width/Height`, kept in sync by a `ResizeObserver` (replacing the `style.left` MutationObserver at :97-103). |
| F3 | `index.tsx:16-17` | Settings button: `'[data-testid=tid_header_setting_btn], .cmd-icon-setting, a[href="#/m/setting/"]'`. On the clone, `removeAttribute('data-testid')` and set `role=button` / `cursor: pointer`. `.href` on a span is harmless. |
| F4 | `index.tsx:69` | `e.path` → `e.composedPath()`. The prelude polyfill already covers it (and covers PluginMarket); patch anyway for clarity. |
| F5 | `index.tsx:76-77` | The lyric-button wait (`div.cover.u-cover.u-cover-sm > a > span`) never resolves. Replace with hiding on clicks inside `[class^=songPlayInfo_], [data-testid=tid_playbar_lyric_btn], #vinyl-page-container`. |
| F6 | `index.tsx:93` | `hashchange` never fires. Add a `MutationObserver` on `main.right-container` (childList, plus the first child's id changing `#page_pc_*`) that hides the panel. Keep the hashchange handler. |
| F7 | `index.tsx:63-67` | Add `[class^=LeftScrollContainer_], [data-testid=tid_left_scroll_container]`. Drop or keep `CommentWrapper_` (it matches 0 elements, harmless). |
| F8 | `components/button.tsx:8-9` | Null-guard `document.querySelector('.cmd-button')`. Prefer the first `.cmd-button` inside `#page_pc_main_nav`. |
| F9 | `betterncm-api/app.ts:72` | `getDataPath`: replace `/` with `\` only if `navigator.platform` does not start with `Mac`. |
| F10 | `betterncm-api/ncm.ts:51-58` | If `appver` has 3 segments, `getNCMVersion()` returns the full appver (`"3.1.14"`) and `getNCMBuild()` parses `/NeteaseMusicDesktop\/[\d.]+\.(\d+)/` from the UA (→ 3459). This keeps semver gating valid. |
| F11 | `betterncm-api/ncm.ts:235-266` | `getPlayingSong`/`getPlaying`: if `findApiFunction` returns null, read the dva store's `playing` slice. Find the store by walking from `document.getElementById('root')._reactRootContainer._internalRoot.current` to the first `memoizedProps.store`. Map `curTrack` to the old `{data: {id, name, artists, album, duration}, state}` shape. **Should**; the exact field mapping needs one live read. |
| F12 | `plugin-manager/components/header.tsx:44-117` | On Mac: skip the update fetch and the WOW64 / cmd / taskkill updater, and show "BetterNCM-mac \<version\>". `exec('explorer "<path>"')` at :140 can stay; the server translates it. |
| F13 | `styles/index.css:4-16, 208-216` | Remove `[class^=IconBar_]{width:200px}` and `[class^=MiniModeIconBar_]{width:160px}` (they would break the Mac header). Keep `WindowOpBarContainer_{gap:5px}` (it matches 0 elements on Mac, harmless). Replace `section.better-ncm-manager{left:20px;top:0;bottom:73px}` with the F2 inline geometry plus `z-index:70; overflow:auto; background: var(--...)`; UI tuning needed. Delete the `body.mq-playing` and `#x-g-mn` rules. |

Left as is on purpose: the `sortPlugins` order bug (loader.ts:238), the slug mismatch for non-ASCII names, `safe-mode` semantics, and the legacy `ReactDOM.render`, which is fine on the page's React 16.14 (only hooks used, no React 18 API; grep confirmed `ReactDOM.render` is the only ReactDOM call).

**Build** (`framework/package.json`):
- `"build": "esbuild ./src/index.ts --bundle --minify --sourcemap=inline --target=chrome116 --outfile=../dist/framework.js"`
- esbuild emits `../dist/framework.css` and reads `jsxFactory: h` / `jsxFragmentFactory: f` from tsconfig.
- Root package.json scripts:
  - `"build:fw": "cd framework && npm ci && npm run build"`
  - `"patch:fw": "node scripts/vendor-framework.mjs"` (copies from the read-only clone and applies the patch)
  - `"start": "node bin/bncm-mac.mjs launch"`
  - `"test": "node --test test/"`

---

## 4. Plugin market

**It works.** It is a normal `injects.Main` plugin and needs F1 plus the routes above.

**Index source.**
- The default `'Default'` source is `https://raw.gitcode.com/intensity/bncm-plugin-packed/raw/master/`, which returned 403 to curl. Its behaviour from the page is unverified (Q5).
- Reliable source: `https://raw.githubusercontent.com/BetterNCM/BetterNCM-Packed-Plugins/master/plugins.json` (85 entries; serves `ACAO: *`).
- At injector start, Node does `HEAD <gitcode>/plugins.json`. If that fails and `localStorage["pluginmarket-source"]` was never set, the prelude seeds it once with `"Github (UserContent)"`. This needs a guard key `bncm-mac.seededSource`. (Uncertain: the remote `sources.json` naming may differ; check the source list in `pm-src/online-sources.ts`.)

**Filter.** The market itself shows only `ncm3-compatible` entries (26/85) that satisfy `betterncm_version` vs 1.3.4. Our extraction then also enforces `ncm-version-req` against 3.1.14. For example, advanced-playbar (`>=3.1.20`) is installed but not loaded; show that in the log.

**Install flow:**
1. `fetch(source + file-url)` gives a blob.
2. `POST /api/fs/write_file?path=./plugins/<file>` (multipart field `file`).
3. The user clicks reload: `/api/app/reload_plugin` (extract, re-register injection), then `location.reload()`.
4. Native plugins use `app.restart` instead.

**Uninstall:** `fs.readFileText(pluginPath + "/.plugin.path.meta")` gives `/plugins/X.plugin`, which the resolver maps to `datapath/plugins/X.plugin`. Then `fs.remove`.

**`extractPackedPlugins()`** (`src/plugins.mjs`; port of PluginManager.cpp:220-324):
1. Create the lock file.
2. Read the disable list.
3. Wipe `plugins_runtime/*`.
4. For each `plugins/*.plugin`:
   - `manifest = JSON.parse(execFileSync('unzip', ['-p', f, 'manifest.json']))`
   - If PluginMarket has a version below 0.7.2, re-seed it.
   - Skip if the slug is in the disable list, or if `!manifest['ncm3-compatible']` (NCM major is 3), or if `!semver.satisfies('3.1.14', manifest['ncm-version-req'] ?? '> 2.10.2', {loose: true})`.
   - Require `manifest_version === 1`.
   - If `native_plugin` is present: still extract, but log "native plugin ignored on macOS".
   - `unzip -o -q f -d plugins_runtime/<slug>`. Reject entries with `..` or absolute paths: check with `unzip -Z1` first.
   - Write `.plugin.path.meta` = `/plugins/<basename>`.
5. Remove the lock.

Slug rule = C++ (keep `-` and non-ASCII). Log every decision.

**NCM version** comes from `defaults read /Applications/NeteaseMusic.app/Contents/Info.plist CFBundleShortVersionString`. Re-read it at each start, because Sparkle may update the app.

**Auto force-update / uninstall** (`app.auto_update`, `microblock.cc/bncm-config.txt`): **off by default** (`cfg.autoForceUpdate`), because it downloads code silently with no signature check. If enabled, port PluginManager.cpp:403-467 as is.

**Analytics** (`incPluginDownload`): left as the market does it. Its user-ID scrape (`.face.u-face.j-flag`) matches nothing on Mac, so no ID is sent.

**Hijack runtime** (`src/prelude/hijack-runtime.js`; replaces the scheme-handler hook):
- **Node side.** Collect actions from `getAllPlugins()` (sorted by slug, deduplicated) with `semver.satisfies(ncmVer, range, {loose: true})`. Remap the prefix `orpheus://orpheus/pub/app.html` → `orpheus://orpheus/app.html`. Ship them as `__BNCM_HIJACKS__ = [{slug, id, prefix, type, from, to, code}]`. Skip all of it in safe mode.
- **Transform.**
  - `regex`: `s.replace(new RegExp(from, 'g'), to)`. ECMAScript `$1` matches `std::wregex` ECMAScript.
  - `replace`: `split(from).join(to)`.
  - `append` / `prepend`: concatenate.
  - Record `slug::id` only when the text changed. Each action is in try/catch.
  - Report to `POST /api/internal/hijack_report`.
- **Parser-inserted scripts.**
  - Install `new MutationObserver(cb).observe(document, {childList: true, subtree: true})` at document start.
  - For each added `SCRIPT` whose `.src` starts with a hijack prefix:
    1. Fetch the text with a sync XHR (P3).
    2. Transform it.
    3. `el.removeAttribute('src'); el.text = code + '\n//# sourceURL=' + url`.
  - This relies on the HTML spec's microtask checkpoint before a `</script>` end tag is prepared, the same technique "yett" uses (Q1).
- **Dynamic webpack chunks.** Wrap `Node.prototype.appendChild` and `insertBefore`. For a `SCRIPT` with a matching `src`:
  1. Rewrite it inline the same way.
  2. Insert it; it runs synchronously, so `webpackJsonp.push` installs the chunk.
  3. Then `queueMicrotask(() => el.dispatchEvent(new Event('load')))`.
- **HTML targets** (`app.html`): body rewriting is impossible. Emulate the CSP ids instead: if `bypassCSP` is on and an action targets app.html with `from` matching `/Content-Security-Policy|script-src/`, report `slug::id`. Log any other app.html actions as unsupported.

---

## 5. Risks, ranked

| # | Risk / unknown | Severity | How to resolve |
|---|---|---|---|
| Q0 | `Page.reload()` of `orpheus://orpheus/app.html` on Mac may break native state: stale `registerCall` seqs on the native side, player or login state. v2 reloads routinely on Windows; Mac is untested. | High; the design relies on reloading | Milestone 0: reload once and check playback, lyrics, login and the mini player. Fallback: `waitForDebuggerOnStart` with a cold launch, so the page is never reloaded and only the first-load race remains (Q2). |
| Q1 | The MutationObserver inline rewrite of parser-inserted scripts is unverified in CEF 116. | High for hijack plugins (RNPN, AMLL); none for the base milestone | Milestone 0b: add a test hijack `{prefix: orpheus://orpheus/pub/hybrid/vendors~app~subApp, type: append, code: 'window.__bncmHijackOk=1'}`, reload, then check the value and that the app boots. Fallback: in the observer, set `el.type='javascript/blocked'` and insert a sibling inline script synchronously. |
| Q2 | Does `Target.setAutoAttach({waitForDebuggerOnStart: true})` on the browser session pause new CEF windows (lyrics, mini player)? | Med | Open the desktop lyrics with the injector running and check that `Target.attachedToTarget` reports `waitingForDebugger: true`. Fallback: reload on attach. |
| Q3 | Side effects of the `window.channel` shim. NCM's `legacyNativeCmder.callAdapter` starts routing through it. Does native allow duplicate `registerCall` for the same command? Is `$$MNBCallbackMap` the map that `MNBCallback` reads, and what is its entry shape? | Med (plugins using `channel` / `legacyNativeCmder`) | Read the NCM module-4 source in `ncm-web/webfiles/hybrid/*.js` (grep `MNBCallbackMap`). Live test: `channel.call("os.navigateExternal", ()=>{}, ["https://example.com"])` and `channel.registerCall("audioplayer.onPlayProgress", console.log)`. Keep it behind `cfg.channelShim`. |
| Q4 | Plugin-manager layout and CSS on the Mac DOM (F2/F13) are guesses. | Med (cosmetic, but it is the milestone UI) | Iterate live with `Runtime.evaluate` / screenshots after milestone 1. |
| Q5 | gitcode default source from the page: CORS or 403. | Low–Med | In milestone 2, check the network panel. The seeding fallback handles it. |
| Q6 | CDP port exposure to local processes; `--remote-debugging-pipe` support in CEF 116. | Med (security) | Spawn the binary directly with fds 3 and 4 and send `Browser.getVersion`. If that works, make pipe mode the default; the downside is the launch not going through LaunchServices. |
| Q7 | DevTools frontend URL in CEF. | Low | `curl http://127.0.0.1:P/devtools/inspector.html` |
| Q8 | Sparkle updates change chunk hashes and DOM classes; plugins with `ncm-version-req` may change. | Low | Selectors use `data-testid` and `cmd-*`; hijacks match by prefix. Re-read the version every start. |
| Q9 | Sync-XHR deprecation warnings and main-thread stalls on large chunk rewrites (the vendors chunk is MBs). | Low | Acceptable; measure in milestone 0b. |
| Q10 | Plugins that are Windows-only in practice: native DLLs, HideLyric's exe, InfLinkrs, `exec` of `.exe`. | Accepted | Log a warning in extraction; `exec` returns 403. |
| Q11 | `getPlayingSong` store mapping (F11). | Low | One live read of `store.getState().playing.curTrack`. |

**Smallest end-to-end proof (milestone order):**
1. **M0** (about 1 day):
   - Launcher plus injector, with no framework.
   - Inject a prelude that logs `document.scripts.length` and `typeof React` at start, which proves document-start timing.
   - Reload once and confirm the app works (Q0).
   - **M0b:** the test hijack (Q1).
2. **M1**: framework + native shim + server + extraction + seeded PluginMarket. **Success:** the BetterNCM icon appears next to `[data-testid=tid_header_setting_btn]`, clicking it opens the panel listing PluginMarket, the console has no errors from `loader.ts`, and `localStorage['betterncm.safemode']==='false'`.
3. **M2**: install **StyleSnippet** (0.2.2: ncm3-compatible, `injects.Main` index.js plus `startup_script.js` plus `onConfig`) from the market (the GitHub source), then reload. **Success:** its config view opens and a CSS snippet visibly applies. Then uninstall it; the `.plugin` is gone after reload.
   - That covers install (multipart), extraction, `.plugin.path.meta`, startup scripts, injects and config.
   - Alternative, no network: drop a dev plugin into `plugins_dev/hello/` with a manifest `{"manifest_version":1,"name":"hello","ncm3-compatible":true,"injects":{"Main":[{"file":"main.js"}]}}` and a `main.js` that injects a `<style>`. Editing it hot-reloads through watchDirectory and SSE.
4. **M3**: channel shim (Q3) and a hijack plugin: AMLL 3.1.0 (no `ncm-version-req`; its hijacks are the CSP one, emulated, and `amllDispatchHook` on `pub/hybrid/vendors`).

---

## 6. File-by-file plan (new project `betterncm-mac/`)

| File | Contents |
|---|---|
| `package.json` | `type: module`, `engines.node >= 22`, deps `semver@^7.6`, devDeps `esbuild@^0.16` (framework). Scripts: `build:fw`, `patch:fw`, `start`, `test`, `install-app`. |
| `bin/bncm-mac.mjs` | CLI subcommands: `launch [--daemon]`, `attach --port N`, `install-app`, `uninstall-app`, `doctor` (prints NCM version, ports, targets, data dir, plugin decisions), `reload`. |
| `src/config.mjs` | datapath resolution (`BETTERNCM_PROFILE` or the default), directory bootstrap, `readConfig` / `writeConfig` (flat string map, atomic), mac config keys (`cdpPort`, `bypassCSP`, `channelShim`, `allowExec`, `allowFsOutsideData`, `autoForceUpdate`), `getNcmVersion()` (Info.plist), `NCM_APP` and `BUNDLE_ID` constants. |
| `src/launcher.mjs` | `findNcm()` (pgrep + ps args → `{pid, port?}`), `pickPort()`, `quitNcm()` (osascript, poll), `launchNcm(port)` (`open -a … --args`), `waitForCdp(port)`, `confirmDialog(msg)`, `restart()` used by `app.restart`. |
| `src/cdp.mjs` | Minimal client on global `WebSocket`: `connect(url)`, `send(method, params, sessionId)`, `on(event, fn)`, per-session event routing, close handling. |
| `src/injector.mjs` | Browser attach, discover / auto-attach, `setupSession(targetId, sessionId)` (Page/Runtime enable, setBypassCSP, addScriptToEvaluateOnNewDocument, reload-if-needed, runIfWaitingForDebugger), `reinjectAll()`, reconnect loop, exit on NCM exit. |
| `src/bundle.mjs` | `buildInjection(targetId)`: concatenates the polyfill, consts, the `prelude/*.js` sources (read at build time), `dist/framework.js` and the startup scripts (from `getAllPlugins()` unless `cpp_side_inject_feature_disabled==="true"`) per §1.3. Hijack JSON comes from `plugins.collectHijacks()`. |
| `src/prelude/native-shim.js` | `betterncm_native` tree with exact arities (§2a), sync XHR `call()`, callback registry, lazy SSE client. |
| `src/prelude/channel-shim.js` | `window.channel` over `ncmChannelOSX` + `$$MNBCallbackMap`, installed in capture-phase `DOMContentLoaded`. |
| `src/prelude/hijack-runtime.js` | MutationObserver + appendChild/insertBefore wrappers, transform engine, report. |
| `src/prelude/devtools-key.js` | F12 / Cmd-Opt-I → `/api/internal/devtools` |
| `src/server.mjs` | `node:http` on 127.0.0.1:0. CORS / OPTIONS, key check, router for every route in §2b, `/api/native/*` dispatcher to `fsapi` / `macos`, `/local` static, `/mounted_file` and `/mounted_dir` registries with Range support, SSE hub keyed by target, `internal/hijack_report`, `internal/devtools`. |
| `src/fsapi.mjs` | `resolve()` (§1.5), `readDir`, `readDirWithDetails`, `readFileText`, `exists`, `getProperties` (FILETIME offset), `writeFileText`, `writeFile`, `remove`, `rename`, `mkdir`, `unzip`, `watchDirectory` (`fs.watch` recursive → SSE), `getDisks`, `getLibraries`, MIME table. |
| `src/plugins.mjs` | `slugOf(name)` (C++ rule), `readManifestFromZip`, `extractPackedPlugins()`, `getDevPlugins()`, `getAllPlugins()`, `collectHijacks(ncmVer)` (with the app.html prefix remap), `seedPluginMarket()` (copy `resources/PluginMarket.plugin`), decision log. |
| `src/zip.mjs` | `listEntries` (`unzip -Z1`, with path-traversal check), `readEntry` (`unzip -p`), `extractAll` (`unzip -o -q -d`). |
| `src/macos.mjs` | `openTarget(urlOrPath)`, `execCommand(cmdline)` (§2b policy), `isLightTheme()`, `openFileDialog(filter, initialDir)` (Win filter → AppleScript types), `openDevtools(port, targetId)`. |
| `src/autoupdate.mjs` | Opt-in port of `performForceInstallAndUpdateSync` (PluginManager.cpp:403-467): fetch `src+plugins.json`, handle `force-uninstall` / `force-update`, fall back to `microblock.cc/bncm-config.txt` line 0. |
| `framework/` | Vendored FW@44b4df2 with `patches/js-framework-mac.patch` applied (F1–F13). Built to `dist/framework.js` and `dist/framework.css`. |
| `scripts/vendor-framework.mjs` | Copies from the read-only clone, then `git apply patches/js-framework-mac.patch`. |
| `resources/PluginMarket.plugin` | Copy of `bncm-v2/resource/PluginMarket.plugin` (0.8.0). |
| `app-wrapper/Info.plist`, `app-wrapper/BetterNCM.sh` | Templates for `install-app`, which fills in the absolute paths to node and the project. |
| `test/fsapi.test.mjs` | Resolver cases: `./plugins_runtime`, `/plugins/X.plugin`, `/__TEST_SUCCEEDED__.txt`, `/Users/...`, `C:\x` (error). |
| `test/plugins.test.mjs` | Extraction against copies of `eco/dl/{StyleSnippet,ZoomNCM,advanced-playbar,material-u-theme-ncmv3}.plugin`: filters and meta contents. |
| `test/hijack.test.mjs` | Transform engine on `vendors~app~subApp.chunk.18d435e.js` with RNPN's `sagaEffects.put"),` action. |

Order to implement:
1. `config`, `cdp`, `launcher`, `injector` with a stub prelude (M0).
2. `hijack-runtime` test (M0b).
3. `fsapi`, `server`, `native-shim`, `plugins`, `zip`, `bundle`, framework patch and build (M1).
4. `macos` and market fixes (M2).
5. `channel-shim` and hijacks for real plugins (M3).
6. `autoupdate` and `install-app` polish.