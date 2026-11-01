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
  and animations itself.

## Messages

Every message is one JSON object.

### Bridge → page

| `t` | Fields | When |
|---|---|---|
| `open` | `frame`, `fullscreen` | The user asked for the lyric page (any entry point). |
| `snapshot` | `track`, `state`, `liked`, `mode`, `volume`, `roaming`, `frame` | Reply to `c:"snapshot"`. |
| `track` | `id`, `title`, `alias`, `artists[{id,name}]`, `album{id,name}`, `duration` (s), `quality`, `cover`, `threadId` | Track changed. |
| `state` | `playing` | Play state changed. |
| `progress` | `id`, `pos` (s), `wall` (`Date.now()`) | Every 250 ms while active, and at once on a jump. |
| `liked` / `mode` / `volume` / `roaming` | `v` | Changed. |
| `reply` | `rid`, `ok`, `data` or `error` | Answer to a page request (`fetch`, `rnpSettings`, …). |

### Page → bridge (`c`)

`snapshot`, `active{v}` (the window is showing, so send progress), `toggle`, `prev`, `next`,
`seek{sec}`, `volume{v}`, `like`, `mode`, `playlist`, `dislike`, `nav{hash}` (navigate NCM, used
with `close`), `fetch{rid,url}` (GET from NCM's page with its cookies; music.163.com and
interface*.music.163.com only), `rnpSettings{rid}` (RNPN's localStorage, for a one-time
migration), `ncmAction{rid,action,...}` (panel and menu actions handed to NCM),
`showNcm{frame}` (move NCM's window to `frame` and bring it to the front).

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
  the store's `dispatch` for `playing/openVinylPage`.
- **Collapsing.** The chevron, Esc, ⌘W and the red button all collapse. NCM's window is moved to the
  lyric window's frame and brought to the front, then the lyric window hides.
- **The yellow button** collapses and minimizes NCM.
- **NCM activated from the Dock or ⌘Tab while the lyric window is open.** The lyric window is
  ordered back above NCM.
- **Background.** The blurred background is rendered by the host once per cover, size and scheme,
  at a quarter size; blur 90 px makes the downscale invisible.
- **Power.** The page animates only `transform` and `opacity`, and JS runs once per lyric line, not
  per frame. A hidden window draws nothing.
