// BNCMLyrics: the lyrics window (LYRICS-WINDOW.md). A WKWebView in a window that opens over NCM's,
// driven by the injector over stdin/stdout (one JSON object per line).
//
//   BNCMLyrics --web <dir> --data <dir> --cache <dir>
//
// The page and its assets are served from bncm://app/ (web dir) and bncm://app/cache/ (covers and
// backgrounds), one origin, so the page can read cover pixels for its accent colour.
import AppKit
import CoreImage
import CryptoKit
import WebKit

// MARK: - Arguments and I/O

func argValue(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}

let webDir = URL(fileURLWithPath: argValue("--web") ?? FileManager.default.currentDirectoryPath, isDirectory: true)
let dataDir = URL(fileURLWithPath: argValue("--data") ?? NSTemporaryDirectory(), isDirectory: true)
let cacheDir = URL(fileURLWithPath: argValue("--cache") ?? NSTemporaryDirectory(), isDirectory: true)
let settingsFile = dataDir.appendingPathComponent("lyrics-settings.json")
let NCM_BUNDLE_ID = "com.netease.163music"

func log(_ s: String) {
    FileHandle.standardError.write(("[lyrics-host] " + s + "\n").data(using: .utf8)!)
}

let outQueue = DispatchQueue(label: "out")
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    outQueue.async { FileHandle.standardOutput.write(line.data(using: .utf8)!) }
}

// MARK: - Assets: bncm://app/<path>

let MIME: [String: String] = [
    "html": "text/html", "js": "text/javascript", "mjs": "text/javascript", "css": "text/css", "json": "application/json",
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "svg": "image/svg+xml",
    "woff2": "font/woff2", "ttf": "font/ttf", "otf": "font/otf",
]

final class AssetHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let base: URL, rel: String
        if path.hasPrefix("/cache/") { base = cacheDir; rel = String(path.dropFirst("/cache/".count)) }
        else { base = webDir; rel = String(path.dropFirst()) }
        let file = base.appendingPathComponent(rel).standardizedFileURL
        // nothing outside the two folders
        guard file.path.hasPrefix(base.standardizedFileURL.path + "/"), let data = try? Data(contentsOf: file) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: [:])!)
            task.didFinish()
            return
        }
        let type = MIME[file.pathExtension.lowercased()] ?? "application/octet-stream"
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                        headerFields: ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": "no-cache"])!)
        task.didReceive(data)
        task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

// MARK: - Covers and backgrounds

func sha(_ s: String) -> String {
    SHA256.hash(data: Data(s.utf8)).prefix(10).map { String(format: "%02x", $0) }.joined()
}

struct BgParams: Equatable {
    var url: String
    var dim: Double      // opacity of the overlay colour, RNPN's --bg-dim
    var overlay: String  // "#000" (dark) or "#fff" (light)
    var blur: Double     // RNPN's --bg-blur, a Gaussian sigma in CSS px
}

let ciContext: CIContext = {
    // browsers dim and blur sRGB-encoded values, not linear light
    let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
    return CIContext(options: [.workingColorSpace: srgb, .outputColorSpace: srgb])
}()

let workQueue = DispatchQueue(label: "covers", qos: .userInitiated)

/// The cover as a local file, downloaded once per URL.
func coverFile(for url: String, done: @escaping (URL?) -> Void) {
    var s = url
    if s.hasPrefix("orpheus://cache/?") { s = String(s.dropFirst("orpheus://cache/?".count)) }
    if s.hasPrefix("http://") { s = "https://" + s.dropFirst("http://".count) } // no ATS exception in a bare binary
    let file = cacheDir.appendingPathComponent("cover-\(sha(s)).img")
    if FileManager.default.fileExists(atPath: file.path) { done(file); return }
    guard let remote = URL(string: s) else { done(nil); return }
    URLSession.shared.dataTask(with: remote) { data, resp, err in
        guard let data, (resp as? HTTPURLResponse)?.statusCode ?? 0 < 400, NSImage(data: data) != nil else {
            log("cover download failed: \(s) \(err?.localizedDescription ?? "")")
            done(nil)
            return
        }
        try? data.write(to: file, options: .atomic)
        done(file)
    }.resume()
}

/// RNPN's rnp-bg-blur: the cover filling the window (background-size: cover), an overlay at `dim`,
/// then a Gaussian blur of `blur` px. Rendered at a quarter of the window size: at sigma 90 the
/// result has no detail a full-size render would keep.
func renderBackground(cover: URL, p: BgParams, size: CGSize) -> URL? {
    let scale: CGFloat = 0.25
    let W = max(16, (size.width * scale).rounded()), H = max(16, (size.height * scale).rounded())
    let name = "bg-\(sha(p.url))-\(Int(W))x\(Int(H))-\(Int(p.dim * 100))-\(p.overlay == "#fff" ? "l" : "d")-\(Int(p.blur)).png"
    let out = cacheDir.appendingPathComponent(name)
    if FileManager.default.fileExists(atPath: out.path) { return out }
    guard let src = CIImage(contentsOf: cover) else { return nil }
    let s = max(W / src.extent.width, H / src.extent.height)
    var img = src.transformed(by: CGAffineTransform(scaleX: s, y: s))
    img = img.transformed(by: CGAffineTransform(translationX: -img.extent.minX - (img.extent.width - W) / 2,
                                                y: -img.extent.minY - (img.extent.height - H) / 2))
    let frame = CGRect(x: 0, y: 0, width: W, height: H)
    let k = CGFloat(1 - p.dim), add = p.overlay == "#fff" ? CGFloat(p.dim) : 0
    img = img.cropped(to: frame).applyingFilter("CIColorMatrix", parameters: [
        "inputRVector": CIVector(x: k, y: 0, z: 0, w: 0), "inputGVector": CIVector(x: 0, y: k, z: 0, w: 0),
        "inputBVector": CIVector(x: 0, y: 0, z: k, w: 0), "inputBiasVector": CIVector(x: add, y: add, z: add, w: 0)])
    img = img.clampedToExtent().applyingGaussianBlur(sigma: Double(p.blur * scale)).cropped(to: frame)
    do {
        try ciContext.writePNGRepresentation(of: img, to: out, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    } catch {
        log("background render failed: \(error)")
        return nil
    }
    return out
}

func pruneCache() {
    // keep the newest 60 files
    guard let files = try? FileManager.default.contentsOfDirectory(at: cacheDir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
    let sorted = files.sorted {
        ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
            > ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
    }
    for f in sorted.dropFirst(60) { try? FileManager.default.removeItem(at: f) }
}

// MARK: - Window

/// The strip along the top that drags the window (the page itself has nothing there but the tools
/// on the right, which it keeps).
final class DragStrip: NSView {
    // a drag works while another app is active, as on a title bar
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
            // minimize the way the yellow button does: the injector collapses to NCM and minimizes it
            if action == "Minimize" { (NSApp.delegate as? Host)?.minimizeBoth() } else if action != "None" { window?.performZoom(nil) }
            return
        }
        window?.performDrag(with: event)
    }
}

/// The first click reaches the page even while NCM (or any other app) is active, as it would in
/// NCM's own window; by default it would only activate this one.
final class LyricsWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class LyricsWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    // Exactly NCM's frame, which may reach under the Dock; AppKit would pull a titled window up.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
    // Full screen is NCM's (its own Space, as when the lyric page was inside NCM's window); this
    // window lays itself over it instead of taking a Space of its own (Host.ncmFullscreen).
    override func toggleFullScreen(_ sender: Any?) { (NSApp.delegate as? Host)?.requestNcmFullscreen() }
    /// AppKit's own full screen. It can still be entered from the green button's hover menu, which
    /// does not go through toggleFullScreen; whatever must leave it calls this.
    func toggleNativeFullScreen() { super.toggleFullScreen(nil) }
}

final class Host: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: LyricsWindow!
    var web: WKWebView!
    var strip: DragStrip!
    var stripClear: CGFloat = 240 // right part of the top strip left to the page's tools (the page reports it)
    var pageReady = false
    var pendingToWeb: [[String: Any]] = []
    var lastBg: BgParams?
    var closing = false
    var wantShown = false  // between the injector's "show" and a close or minimize
    var ncmFS = false      // NCM is in full screen: this window covers NCM's full-screen Space
    var hiding = false     // "hide" arrived in full screen: order out once full screen is left
    var entering = false   // on its way into full screen
    var collapsing = false // a collapse to NCM (beginClose), not a minimize or the injector's own hide
    var pendingFS: Bool?   // asked NCM for this full-screen state, no answer yet
    var preFSFrame: NSRect? // the windowed frame before the window covered the screen for NCM's full screen
    var reopenedAt: Date?  // shown again while a collapse was still waiting for its "hide"
    var reloadDelay: TimeInterval = 1
    var closeTimer: Timer?
    var followTimer: Timer?
    var resizeTimer: Timer?
    var boundsTimer: Timer?
    var reloadTimer: Timer?

    func applicationDidFinishLaunching(_ n: Notification) {
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        workQueue.async { pruneCache() }

        window = LyricsWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.title = "歌词"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 900, height: 600)
        window.backgroundColor = NSColor(white: 0.2, alpha: 1) // RNPN's #333 until the page paints
        window.delegate = self
        window.collectionBehavior = Host.windowed
        hookButtons()

        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(AssetHandler(), forURLScheme: "bncm")
        cfg.userContentController.add(self, name: "b")
        cfg.suppressesIncrementalRendering = true
        web = LyricsWebView(frame: window.contentView!.bounds, configuration: cfg)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        window.contentView!.addSubview(web)
        if ProcessInfo.processInfo.environment["BNCM_LYRICS_TEST"] == "1" {
            // tests while the screen is locked: draw and animate even when the window cannot be seen
            let sel = Selector(("_setWindowOcclusionDetectionEnabled:"))
            if web.responds(to: sel) { web.perform(sel, with: false) }
        }

        strip = DragStrip(frame: .zero)
        window.contentView!.addSubview(strip)
        layoutStrip()

        web.load(URLRequest(url: URL(string: "bncm://app/index.html")!))

        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(appActivated(_:)),
                                                          name: NSWorkspace.didActivateApplicationNotification, object: nil)
        startStdin()
    }

    func layoutStrip() {
        let b = window.contentView!.bounds
        // left of the page's top-right tools, which keep their clicks; the page reports how wide they get
        strip.frame = NSRect(x: 0, y: b.height - 40, width: max(0, b.width - stripClear), height: 40)
        strip.autoresizingMask = [.width, .minYMargin]
    }

    // MARK: stdin

    func startStdin() {
        let input = FileHandle.standardInput
        DispatchQueue.global(qos: .userInitiated).async {
            var buffer = Data()
            while true {
                let chunk = input.availableData
                if chunk.isEmpty { DispatchQueue.main.async { NSApp.terminate(nil) }; return } // injector gone
                buffer.append(chunk)
                while let nl = buffer.firstIndex(of: 0x0A) {
                    let line = buffer.subdata(in: buffer.startIndex..<nl)
                    buffer.removeSubrange(buffer.startIndex...nl)
                    guard !line.isEmpty, let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                    DispatchQueue.main.async { self.fromInjector(obj) }
                }
            }
        }
    }

    func fromInjector(_ m: [String: Any]) {
        if m["to"] as? String == "web", let msg = m["msg"] as? [String: Any] { toWeb(msg); return }
        guard m["to"] as? String == "host" else { return }
        switch m["op"] as? String {
        case "show": show(frame: m["frame"] as? [String: Any], fullscreen: m["fullscreen"] as? Bool ?? false)
        case "hide": hide()
        case "ncmFullscreen": ncmFullscreen(m["v"] as? Bool ?? false, frame: m["frame"] as? [String: Any])
        case "snapshot":
            // development: a PNG of the page at the window's backing scale
            let id = m["id"] ?? 0
            let path = m["path"] as? String ?? ""
            let cfg = WKSnapshotConfiguration()
            cfg.afterScreenUpdates = true
            web.takeSnapshot(with: cfg) { image, err in
                guard let image, let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
                      let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]),
                      (try? png.write(to: URL(fileURLWithPath: path))) != nil else {
                    emit(["from": "host", "op": "evalResult", "id": id, "error": "snapshot failed: \(String(describing: err))"])
                    return
                }
                emit(["from": "host", "op": "evalResult", "id": id, "value": path])
            }
        case "eval":
            // development: the injector's /api/internal/lyrics_eval
            let id = m["id"] ?? 0
            let js = m["js"] as? String ?? ""
            web.callAsyncJavaScript("return await (async () => { return JSON.stringify(await eval(js)); })()", arguments: ["js": js],
                                    in: nil, in: .page) { result in
                switch result {
                case .success(let v): emit(["from": "host", "op": "evalResult", "id": id, "value": v as? String ?? NSNull()])
                case .failure(let e): emit(["from": "host", "op": "evalResult", "id": id, "error": "\(e)"])
                }
            }
        default: break
        }
    }

    // MARK: page messaging

    func toWeb(_ msg: [String: Any]) {
        guard pageReady else {
            pendingToWeb.append(msg)
            // a page that does not come back must not grow this without end
            if pendingToWeb.count > 500 { pendingToWeb.removeFirst(pendingToWeb.count - 500) }
            return
        }
        guard let data = try? JSONSerialization.data(withJSONObject: msg), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.B && B.receive(\(json))", completionHandler: nil)
    }

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        // only our own page's main frame speaks for the page
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "bncm", origin.host == "app" else { return }
        guard let m = message.body as? [String: Any] else { return }
        guard let op = m["h"] as? String else { emit(["from": "web", "msg": m]); return }
        switch op {
        case "ready":
            pageReady = true
            reloadDelay = 1
            let settings = (try? Data(contentsOf: settingsFile)).flatMap { try? JSONSerialization.jsonObject(with: $0) }
            toWeb(["t": "host.settings", "data": settings ?? NSNull()])
            sendWindowState()
            let queued = pendingToWeb
            pendingToWeb = []
            queued.forEach(toWeb)
        case "close": beginClose()
        case "toggleFullscreen": requestNcmFullscreen()
        case "minimize": minimizeBoth()
        case "cover":
            let p = BgParams(url: m["url"] as? String ?? "", dim: m["dim"] as? Double ?? 0.55,
                             overlay: m["overlay"] as? String ?? "#000", blur: m["blur"] as? Double ?? 90)
            lastBg = p
            prepareCover(p)
        case "saveSettings":
            if let d = m["data"], let data = try? JSONSerialization.data(withJSONObject: d, options: [.prettyPrinted, .sortedKeys]) {
                try? data.write(to: settingsFile, options: .atomic)
            }
        case "copy":
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(m["text"] as? String ?? "", forType: .string)
        case "dragClear":
            if let r = m["right"] as? Double, r.isFinite, r >= 0 { stripClear = CGFloat(r); layoutStrip() }
        case "log": log("page: \(m["msg"] ?? "")")
        default: break
        }
    }

    func prepareCover(_ p: BgParams) {
        guard !p.url.isEmpty else { return }
        let size = web.bounds.size
        coverFile(for: p.url) { file in
            guard let file else {
                // answer anyway, or the page keeps the previous cover with its spinner
                DispatchQueue.main.async { if self.lastBg == p { self.toWeb(["t": "host.cover", "url": p.url, "failed": true]) } }
                return
            }
            workQueue.async {
                let bg = renderBackground(cover: file, p: p, size: size)
                DispatchQueue.main.async {
                    guard self.lastBg == p else { return } // a newer cover or setting won
                    var msg: [String: Any] = ["t": "host.cover", "url": p.url, "cover": "bncm://app/cache/\(file.lastPathComponent)"]
                    if let bg { msg["bg"] = "bncm://app/cache/\(bg.lastPathComponent)" }
                    self.toWeb(msg)
                }
            }
        }
    }

    // MARK: show / close

    func cocoaFrame(_ f: [String: Any]?) -> NSRect? {
        guard let f, let x = f["x"] as? Double, let y = f["y"] as? Double, let w = f["w"] as? Double, let h = f["h"] as? Double,
              let primary = NSScreen.screens.first else { return nil }
        return NSRect(x: x, y: primary.frame.maxY - y - h, width: w, height: h)
    }

    func topLeftFrame() -> [String: Any] {
        let f = window.frame, primary = NSScreen.screens.first?.frame.maxY ?? f.maxY
        return ["x": f.minX, "y": primary - f.maxY, "w": f.width, "h": f.height]
    }

    func show(frame: [String: Any]?, fullscreen: Bool) {
        // the "hide" for that collapse may still be on its way (hide)
        reopenedAt = collapsing ? Date() : nil
        closing = false
        hiding = false
        collapsing = false
        wantShown = true
        closeTimer?.invalidate()
        followTimer?.invalidate()
        boundsTimer?.invalidate()
        pendingFS = nil
        if !fullscreen { preFSFrame = nil }
        if NSApp.isHidden { NSApp.unhide(nil) }
        setNcmFS(fullscreen)
        if ncmFS { window.setFrame(fullscreenFrame(frame), display: false) }
        else if !window.isVisible, let r = cocoaFrame(frame) { window.setFrame(r, display: false) }
        showInActiveSpace()
        sendWindowState()
    }

    // MARK: NCM's full screen

    // no tiling from the green button's hover menu: that is AppKit's full screen, not NCM's
    static let windowed: NSWindow.CollectionBehavior = [.fullScreenPrimary, .fullScreenDisallowsTiling]
    // allowed in another app's full-screen Space
    static let overNcm: NSWindow.CollectionBehavior = [.fullScreenAuxiliary]
    // while NCM animates into or out of full screen: on every Space, so it is on top of NCM's at once
    static let following: NSWindow.CollectionBehavior = [.fullScreenAuxiliary, .canJoinAllSpaces]

    /// What NCM's full-screen window covers: the screen below the camera housing, where a notched
    /// display's menu bar lives (macOS keeps full-screen content out of it).
    func screenFrame() -> NSRect {
        guard let sc = window.screen ?? NSScreen.main else { return window.frame }
        var f = sc.frame
        if #available(macOS 12.0, *) { f.size.height -= sc.safeAreaInsets.top }
        return f
    }

    /// NCM's own full-screen frame when it reported one, else the same area worked out here.
    func fullscreenFrame(_ frame: [String: Any]?) -> NSRect {
        if let r = cocoaFrame(frame), r.width > 0, r.height > 0 { return r }
        return screenFrame()
    }

    /// Shows the window, key, in the Space that is active now (NCM's full-screen one when NCM is in
    /// full screen), then pins it there: with .moveToActiveSpace left on it would follow the user to
    /// any Space where it is activated, and leave NCM's full screen without its lyric page.
    func showInActiveSpace() {
        let base = ncmFS ? Host.overNcm : Host.windowed
        window.collectionBehavior = base.union(.moveToActiveSpace)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        keepAboveNcm(true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self, self.window.collectionBehavior == base.union(.moveToActiveSpace) else { return }
            self.window.collectionBehavior = base
        }
    }

    /// The yellow and green buttons (AppKit makes new ones when the window gets its title bar back).
    func hookButtons() {
        window.standardWindowButton(.miniaturizeButton)?.target = self
        window.standardWindowButton(.miniaturizeButton)?.action = #selector(minimizeBoth)
        window.standardWindowButton(.zoomButton)?.target = self
        window.standardWindowButton(.zoomButton)?.action = #selector(requestNcmFullscreen)
    }

    func setNcmFS(_ v: Bool) {
        let was = ncmFS
        ncmFS = v
        if v != was || window.styleMask.contains(.titled) == v {
            // square corners and no title bar over a full screen, as a native full-screen window
            if v { window.styleMask.remove(.titled) } else { window.styleMask.insert(.titled); hookButtons() }
            web.frame = window.contentView!.bounds
            layoutStrip()
        }
        window.collectionBehavior = v ? Host.overNcm : Host.windowed
        strip.isHidden = v // nothing to drag over a full screen
        // as in native full screen: the auto-hidden menu bar would slide over them anyway; ⌃⌘F leaves,
        // and a collapse shows NCM's full-screen window
        for b in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { window.standardWindowButton(b)?.isHidden = v }
    }

    /// The green button: NCM goes into (or out of) full screen and the window follows (ncmFullscreen).
    @objc func requestNcmFullscreen() {
        // in AppKit's own full screen after all (the hover menu): leave it
        if window.styleMask.contains(.fullScreen) { window.toggleNativeFullScreen(); return }
        guard wantShown, !closing else { return }
        // from the state already asked for: two toggles before NCM answers go there and back
        let v = !(pendingFS ?? ncmFS)
        log("requestNcmFullscreen v \(v)")
        pendingFS = v
        boundsTimer?.invalidate()
        window.collectionBehavior = Host.following
        keepAboveNcm(true)
        // cover the screen at once: NCM's own window grows to it under this one
        if v && !ncmFS {
            if preFSFrame == nil { preFSFrame = window.frame }
            window.setFrame(screenFrame(), display: true)
        }
        emit(["from": "host", "op": "setFullscreen", "v": v])
        // NCM did not move (e.g. not allowed): settle back
        followTimer?.invalidate()
        followTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in
            guard let self, self.window.collectionBehavior == Host.following else { return }
            self.pendingFS = nil
            self.setNcmFS(self.ncmFS)
            if !self.ncmFS, let r = self.preFSFrame { self.preFSFrame = nil; self.window.setFrame(r, display: true) }
        }
    }

    /// NCM entered or left full screen (the injector's "ncmFullscreen", NCM's new frame with it).
    func ncmFullscreen(_ v: Bool, frame: [String: Any]?) {
        log("ncmFullscreen \(v) frame \(frame ?? [:]) shown \(wantShown) closing \(closing)")
        followTimer?.invalidate()
        boundsTimer?.invalidate()
        pendingFS = nil
        let saved = preFSFrame
        if !v { preFSFrame = nil }
        setNcmFS(v)
        guard wantShown, !closing else { return }
        if v { window.setFrame(fullscreenFrame(frame), display: true) }
        else {
            // the frame NCM's page reports is stale: covered by this window, Chromium keeps the
            // full-screen screenX/outerWidth and fires no resize. Start from the frame before full
            // screen and take NCM's real one from the window server once it has settled.
            if let r = saved ?? cocoaFrame(frame) { window.setFrame(r, display: true) }
            followNcmWindowedFrame()
        }
        // shown and made key in the Space that is active now: NCM's full-screen one, or the desktop
        showInActiveSpace()
        sendWindowState()
    }

    /// NCM's main window after it left full screen: polled briefly (it animates) until it is no
    /// longer screen-sized and the same twice, then the window takes it.
    func followNcmWindowedFrame() {
        boundsTimer?.invalidate()
        var last: NSRect?, ticks = 0
        boundsTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] t in
            guard let self, self.wantShown, !self.closing, !self.ncmFS, ticks < 17 else { t.invalidate(); return }
            ticks += 1
            let r = self.ncmMainWindowFrame()
            if let r, !self.isFullScreenSize(r), r == last {
                t.invalidate()
                if r != self.window.frame { self.window.setFrame(r, display: true) }
                return
            }
            last = r
        }
    }

    /// NCM's main window (layer 0, on screen, player-sized, the largest) as the window server has
    /// it, in Cocoa coordinates.
    func ncmMainWindowFrame() -> NSRect? {
        guard let pid = NSRunningApplication.runningApplications(withBundleIdentifier: NCM_BUNDLE_ID).first?.processIdentifier,
              let primary = NSScreen.screens.first,
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { return nil }
        let rects = list.compactMap { w -> CGRect? in
            guard (w[kCGWindowOwnerPID as String] as? Int32) == pid, (w[kCGWindowLayer as String] as? Int) == 0,
                  let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b as CFDictionary),
                  r.width >= 600, r.height >= 400 else { return nil }
            return r
        }
        guard let r = rects.max(by: { $0.width * $0.height < $1.width * $1.height }) else { return nil }
        return NSRect(x: r.minX, y: primary.frame.maxY - r.minY - r.height, width: r.width, height: r.height)
    }

    /// The size of a full-screen window on some screen (with or without a notched display's menu bar).
    func isFullScreenSize(_ r: NSRect) -> Bool {
        NSScreen.screens.contains { sc in
            var top: CGFloat = 0
            if #available(macOS 12.0, *) { top = sc.safeAreaInsets.top }
            return abs(r.width - sc.frame.width) < 1 && (abs(r.height - sc.frame.height) < 1 || abs(r.height - (sc.frame.height - top)) < 1)
        }
    }

    func beginClose() {
        guard window.isVisible, !closing else { return }
        if window.styleMask.contains(.fullScreen) {
            // leave full screen first, then hand NCM the windowed frame
            closing = true
            window.toggleNativeFullScreen()
            return
        }
        closing = true
        collapsing = true
        reopenedAt = nil
        let f = window.frame
        // winhelper.setWindowPosition takes a bottom-left origin, Cocoa's
        emit(["from": "host", "op": "closing", "frame": topLeftFrame(),
              "cocoa": ["x": f.minX, "y": f.minY, "w": f.width, "h": f.height]])
        // NCM is moved and raised by the injector, which then sends "hide"; don't wait forever
        closeTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in self?.finishClose() }
    }

    /// The injector's "hide". A window in full screen leaves it first, as in beginClose, or its Space
    /// would stay behind empty.
    func hide() {
        // late, for a collapse before the window was opened again: ignored once, and only soon after
        // (any other "hide", e.g. an open NCM's page could not be told about, still closes it)
        if !closing, wantShown, let t = reopenedAt {
            reopenedAt = nil
            if -t.timeIntervalSinceNow < 6 { log("stale hide ignored"); return }
        }
        if entering { hiding = true; return } // windowDidEnterFullScreen leaves it again
        if window.styleMask.contains(.fullScreen) {
            hiding = true
            if !closing { closing = true; window.toggleNativeFullScreen() } // else beginClose is already leaving it
            return
        }
        finishClose()
    }

    func finishClose() {
        closeTimer?.invalidate()
        followTimer?.invalidate()
        boundsTimer?.invalidate()
        pendingFS = nil
        if window.collectionBehavior == Host.following { window.collectionBehavior = ncmFS ? Host.overNcm : Host.windowed }
        let collapse = collapsing
        collapsing = false
        reopenedAt = nil
        wantShown = false
        window.level = .normal
        guard window.isVisible else { closing = false; return }
        window.orderOut(nil)
        closing = false
        sendWindowState()
        // NCM is in front now: give it the keys and its first click, or this app stays active with no window
        if collapse, NSApp.isActive { NSRunningApplication.runningApplications(withBundleIdentifier: NCM_BUNDLE_ID).first?.activate(options: []) }
    }

    @objc func minimizeBoth() {
        // like the yellow button, which full screen disables: ordering out would leave an empty Space
        // nor while NCM is on its way into or out of full screen
        guard !window.styleMask.contains(.fullScreen), !ncmFS, window.collectionBehavior != Host.following else { return }
        followTimer?.invalidate()
        boundsTimer?.invalidate()
        pendingFS = nil
        // the frame NCM takes before it is minimized, as with "closing"
        let f = window.frame
        wantShown = false
        window.level = .normal
        emit(["from": "host", "op": "minimizing", "frame": topLeftFrame(),
              "cocoa": ["x": f.minX, "y": f.minY, "w": f.width, "h": f.height]])
        window.orderOut(nil)
        sendWindowState()
    }

    @objc func appActivated(_ n: Notification) {
        guard let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
        keepAboveNcm(app.bundleIdentifier == NCM_BUNDLE_ID || app == NSRunningApplication.current)
    }

    /// While NCM or this window is the active app, the lyric page floats one level up: NCM raises its
    /// own window whenever it is activated (Dock, ⌘Tab, AppleScript, or a click on the menu bar, which
    /// shows NCM's menus while this accessory app is in front), even when it already was active and no
    /// notice comes. Any other app in front: back to normal, so its windows cover the page as usual.
    func keepAboveNcm(_ up: Bool) {
        let on = up && wantShown && !closing && !window.styleMask.contains(.fullScreen)
        let was = window.level
        window.level = on ? .floating : .normal
        guard on else {
            // back among normal windows: right above NCM's, which it was covering
            if was != .normal, wantShown, let n = ncmWindowNumber() { window.order(.above, relativeTo: n) }
            return
        }
        if NSApp.isHidden { NSApp.unhideWithoutActivation() }
        window.orderFrontRegardless()
    }

    /// NCM's frontmost on-screen window at the normal level.
    func ncmWindowNumber() -> Int? {
        guard let pid = NSRunningApplication.runningApplications(withBundleIdentifier: NCM_BUNDLE_ID).first?.processIdentifier,
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { return nil }
        let w = list.first { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
        return w?[kCGWindowNumber as String] as? Int
    }

    func sendWindowState() {
        let b = web.bounds.size
        toWeb(["t": "host.window", "w": b.width, "h": b.height, "visible": window.isVisible,
               "fullscreen": ncmFS || window.styleMask.contains(.fullScreen)])
    }

    // MARK: NSWindowDelegate

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        beginClose()
        return false
    }

    func windowDidResize(_ n: Notification) {
        sendWindowState()
        resizeTimer?.invalidate()
        resizeTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: false) { [weak self] _ in
            guard let self, let p = self.lastBg, !self.window.inLiveResize else { return }
            self.prepareCover(p)
        }
    }

    func windowDidEndLiveResize(_ n: Notification) {
        if let p = lastBg { prepareCover(p) }
    }

    func windowDidExitFullScreen(_ n: Notification) {
        sendWindowState()
        if hiding { hiding = false; finishClose() } else if closing { closing = false; beginClose() }
        else { let f = NSWorkspace.shared.frontmostApplication; keepAboveNcm(f?.bundleIdentifier == NCM_BUNDLE_ID || f == NSRunningApplication.current) }
    }

    func windowDidFailToExitFullScreen(_ window: NSWindow) {
        if hiding { hiding = false; finishClose() }
    }

    func windowWillEnterFullScreen(_ n: Notification) { entering = true; window.level = .normal }

    func windowDidEnterFullScreen(_ n: Notification) {
        entering = false
        sendWindowState()
        if hiding { closing = true; window.toggleNativeFullScreen() } // "hide" came while entering
    }

    func windowDidFailToEnterFullScreen(_ window: NSWindow) {
        entering = false
        if hiding { hiding = false; finishClose() }
    }

    // MARK: WKNavigationDelegate

    static func isApp(_ url: URL?) -> Bool { url?.scheme == "bncm" && url?.host == "app" }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // the page and its frames stay on bncm://app: a dropped link or file must not replace it
        if Host.isApp(action.request.url) { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        if action.navigationType == .linkActivated, let url = action.request.url, ["http", "https"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if !Host.isApp(webView.url) { reloadPage("lost the page to \(webView.url?.scheme ?? "?")") }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { log("page loaded") }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        reloadLater("page failed to load: \(error.localizedDescription)", error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        reloadLater("page failed: \(error.localizedDescription)", error)
    }

    /// A failed load of our page: try again a little later, backing off while it keeps failing.
    func reloadLater(_ why: String, _ error: Error) {
        let e = error as NSError
        // superseded by another load, or a navigation the policy above refused
        if (e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled) || (e.domain == "WebKitErrorDomain" && e.code == 102) { return }
        log(why)
        guard reloadTimer?.isValid != true else { return }
        let delay = reloadDelay
        reloadDelay = min(reloadDelay * 2, 30)
        reloadTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in self?.reloadPage("load failed") }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        reloadPage("web content process terminated")
    }

    /// Our page, fresh. Messages for it queue until it says "ready" again.
    func reloadPage(_ why: String) {
        log("\(why); reloading")
        pageReady = false
        web.load(URLRequest(url: URL(string: "bncm://app/index.html")!))
    }
}

let app = NSApplication.shared
let host = Host()
app.delegate = host
app.setActivationPolicy(.accessory) // no Dock icon: the window belongs to NCM as far as the user is concerned
app.run()
