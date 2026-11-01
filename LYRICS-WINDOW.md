# Lyrics window ("B")

The lyric page in its own native window, in place of RefinedNowPlayingNext (RNPN) inside NCM's
page. RNPN's page costs about half a core while it is open (NCM's Chromium redraws a React page with
a live backdrop blur and per-line filters). The same page drawn by WebKit with compositor-only
animations and a background blurred once costs a fraction of that. NCM's own window sits covered
behind it and stops drawing.

Config `mac.lyricsWindow` (default `'true'`). With `'false'`, RNPN and the `compat-rnp-*`
preludes load as before.

## Pieces

```
NCM page ── lyrics-bridge.js (prelude) ──Runtime.addBinding / Runtime.evaluate── injector (Node)
                                                                                     │ stdin/stdout, JSON lines
                                                                       BNCMLyrics (Swift, resources/lyrics/)
                                                                                     │ WKScriptMessageHandler / evaluateJavaScript
                                                                       web page (resources/lyrics/web/, bncm://app/)
```

- **Bridge** (`src/prelude/lyrics-bridge.js`): reads NCM's redux store and native events and runs
  commands in NCM's page. It holds no UI, and it posts nothing while the window is closed, except the
  request to open it.
- **Injector** (`src/lyrics-window.mjs`): adds the binding to NCM's main page and starts the host the
  first time the window is opened. It relays messages and stops the host when NCM goes away.
- **Host** (`native/lyrics-host/main.swift`, prebuilt universal binary `resources/lyrics/BNCMLyrics`):
  owns the window and its frame, serves the page and its assets from `bncm://app/`, downloads covers,
  renders the blurred background once per cover and size, and keeps the settings file.
- **Page** (`resources/lyrics/web/`): everything you see. It runs RNPN's layout, lyric parser, clock
  and animations itself. Besides the lyrics it has the 百科 / 相似推荐 / 评论 panels (`js/panels/`),
  the settings popover (`js/settings-ui.js`), the ··· menu (`js/menu.js`) and copy mode
  (`js/copy-mode.js`). Each loads its code and stylesheet the first time it is used.

## Messages

Every message is one JSON object.

### Bridge → page

| `t` | Fields | When |
|---|---|---|
| `open` | `frame`, `fullscreen`, `version` | The user asked for the lyric page (any entry point). The injector adds `version`. |
| `hello` | | The bridge booted, or was asked to say hello again. |
| `snapshot` | `track`, `playing`, `liked`, `mode`, `volume`, `roaming`, `frame`, `fullscreen`, `dislikeIcon` | Reply to `c:"snapshot"`. |
| `track` | `id`, `playId`, `title`, `alias`, `trans`, `artists[{id,name}]`, `album{id,name}`, `duration` (s), `quality` (NCM's number as a string), `qualityName`, `envSound`, `fileType`, `local`, `cover`, `threadId` | Track changed. |
| `state` | `playing` | Play state changed. |
| `progress` | `id`, `pos` (s), `wall` (`Date.now()`) | Every 250 ms while active, and at once on a jump. |
| `liked` / `mode` / `volume` / `roaming` | `v` (`roaming` also has `icon`, NCM's dislike SVG) | Changed. |
| `reply` | `rid`, `ok`, `data` or `error` | Answer to a page request (`fetch`, `rnpSettings`, …). |

### Page → bridge (`c`)

`hello`, `snapshot`, `active{v}` (the window is showing, so send progress), `toggle`, `prev`, `next`,
`seek{sec}`, `volume{v}`, `like`, `mode`, `playlist`, `dislike`, `nav{hash}` (navigate NCM, used
with `close`), `fetch{rid,url}` (GET from NCM's page with its cookies; music.163.com and
interface*.music.163.com only), `rnpSettings{rid}` (RNPN's localStorage, for a one-time
migration), `ncmAction{rid,action,...}` (panel and menu actions handed to NCM),
`showNcm{frame}` (move NCM's window to `frame` and bring it to the front), `minimizeNcm`,
`accentPixels{rid,url}` (the cover scaled to 32×32 by NCM's Chromium, for the accent colour),
`fallback` (the window cannot open: let NCM open its own page).

`nav` takes NCM 3 paths (`/album/1`) or RNPN's old `#/m/…` hashes, which go through NCM's own link
action.

### NCM actions (`ncmAction`)

Panels and the ··· menu need more of NCM than the bridge itself offers. Each `src/prelude/lyrics-actions-*.js`
adds handlers to `window.__bncmLyricsActions`; a handler gets the message and the bridge's helpers
(`getStore`, `dispatch`, `post`, `clickEl`, `nativeCall`, `navigate`, `readTrack`, `trackId`, `require`)
and its return value is the reply.

| File | Actions |
|---|---|
| `lyrics-actions-wiki.js` | `wikiGet` (the song wiki, signed inside NCM's page: its key never leaves it), `wikiCtx`, `wikiOpen`, `wikiPlay`, `wikiTrack` |
| `lyrics-actions-comment.js` | `commentLike`, `commentLogin`, `commentPublish` (NCM's reply dialog), `commentShare`, `commentLink` (user, @nickname, topic, hot comments only), `commentOpenUrl`, `commentAssets` (emoji as data URLs: the window cannot load `orpheus://`) |
| `lyrics-actions-menu.js` | `menuInfo` (play speed), `menuSpeed`, `menuLink` (artist, album), `menuRun` (favourite, download, share) |

### Page ↔ host (`h`)

Page to host:
- `ready`
- `close`: collapse to NCM.
- `minimize`
- `cover{url, dim, overlay, blur}`
- `saveSettings{data}`
- `copy{text}`
- `log{msg}`

Host to page (`t` starting with `host.`):
- `host.settings{data}`
- `host.cover{url, cover, bg}`: asset URLs under `bncm://app/cache/`.
- `host.window{w, h, fullscreen, visible}`

### Injector ↔ host

Host stdin:
- `{to:"web", msg}`
- `{to:"host", op:"show", frame, fullscreen}`
- `{to:"host", op:"hide"}`

Host stdout:
- `{from:"web", msg}`: the injector sends `msg` to the bridge when it has `c`.
- `{from:"host", op:"closing", frame}`: the injector runs `showNcm` and then sends `hide`.
- `{from:"host", op:"minimizing"}`
- `{from:"host", op:"log", msg}`

`frame` is `{x, y, w, h}` in points with a top-left origin on the primary screen, which is what NCM's
`window.screenX`/`screenY`/`outerWidth`/`outerHeight` and `winhelper.setWindowPosition` use.

## Window behaviour

- **Opening.** The window opens exactly over NCM's window, so NCM is covered and stops drawing.
  The open request comes from every place NCM would open its own now-playing page: the bridge wraps
  `next` of NCM's vinyl-page subject (found by shape among the loaded modules) and turns `'opening'`
  into `{t:'open'}`. If the subject is not found it falls back to catching the cover click and the
  store. Shift-click opens NCM's own page.
- **Starting.** The injector starts the host, hidden, a few seconds after NCM's page is ready, so the
  first open does not wait for WebKit.
- **Collapsing.** The chevron, Esc, ⌘W and the red button all collapse. NCM's window is moved to the
  lyric window's frame and brought to the front, then the lyric window hides.
- **The yellow button** collapses and minimizes NCM.
- **NCM activated from the Dock or ⌘Tab while the lyric window is open.** The lyric window is
  ordered back above NCM.
- **Background.** The blurred background is rendered by the host once per cover, size and scheme,
  at a quarter size; blur 90 px makes the downscale invisible.
- **Power.** The page animates only `transform` and `opacity`, and JS runs once per lyric line, not
  per frame. A hidden window draws nothing.

## Development

- **Rebuild the host** after changing `native/lyrics-host/`: run `scripts/build-lyrics-host.sh`. It needs the Command Line
  Tools and commits the result as `resources/lyrics/BNCMLyrics`, a universal binary for macOS 11 and later. Installs
  never compile it.
- **Run JS in the window's page**: `POST /api/internal/lyrics_eval` with the JS as the body. The value of the
  expression comes back; a promise is awaited.
- **Take a PNG of the page**: `POST /api/internal/lyrics_snapshot?path=/abs/file.png`.
  - Both routes need the API key; the port and key are in `run/state.json`.
- **`mac.lyricsTest: "true"`**: the window draws and animates even while it cannot be seen, for example with the
  screen locked, so snapshots still work. Leave it off otherwise: a covered or hidden window must stop drawing.
- **The page has no build step.** Edit the files under `resources/lyrics/web/` and open the window again; the host
  serves them fresh each time.
- **Lyric parser tests**: `test/lyrics-parse.test.mjs` compares `parse.js` with RNPN's own output (`window.currentLyrics`)
  on recorded API responses in `test/fixtures/lyrics/`.
