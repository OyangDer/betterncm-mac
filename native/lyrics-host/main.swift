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
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
            if action == "Minimize" { window?.performMiniaturize(nil) } else if action != "None" { window?.performZoom(nil) }
            return
        }
        window?.performDrag(with: event)
    }
}

final class LyricsWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    // Exactly NCM's frame, which may reach under the Dock; AppKit would pull a titled window up.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

final class Host: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: LyricsWindow!
    var web: WKWebView!
    var strip: DragStrip!
    var pageReady = false
    var pendingToWeb: [[String: Any]] = []
    var lastBg: BgParams?
    var closing = false
    var closeTimer: Timer?
    var resizeTimer: Timer?

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
        window.collectionBehavior = [.fullScreenPrimary]
        window.standardWindowButton(.miniaturizeButton)?.target = self
        window.standardWindowButton(.miniaturizeButton)?.action = #selector(minimizeBoth)

        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(AssetHandler(), forURLScheme: "bncm")
        cfg.userContentController.add(self, name: "b")
        cfg.suppressesIncrementalRendering = true
        web = WKWebView(frame: window.contentView!.bounds, configuration: cfg)
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
        // left of the page's top-right tools (about 220 pt with the hidden ones shown)
        strip.frame = NSRect(x: 0, y: b.height - 40, width: max(0, b.width - 240), height: 40)
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
        case "hide": finishClose()
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
        guard pageReady else { pendingToWeb.append(msg); return }
        guard let data = try? JSONSerialization.data(withJSONObject: msg), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.B && B.receive(\(json))", completionHandler: nil)
    }

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any] else { return }
        guard let op = m["h"] as? String else { emit(["from": "web", "msg": m]); return }
        switch op {
        case "ready":
            pageReady = true
            let settings = (try? Data(contentsOf: settingsFile)).flatMap { try? JSONSerialization.jsonObject(with: $0) }
            toWeb(["t": "host.settings", "data": settings ?? NSNull()])
            sendWindowState()
            let queued = pendingToWeb
            pendingToWeb = []
            queued.forEach(toWeb)
        case "close": beginClose()
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
        case "log": log("page: \(m["msg"] ?? "")")
        default: break
        }
    }

    func prepareCover(_ p: BgParams) {
        guard !p.url.isEmpty else { return }
        let size = web.bounds.size
        coverFile(for: p.url) { file in
            guard let file else { return }
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
        closing = false
        closeTimer?.invalidate()
        if !window.isVisible, let r = cocoaFrame(frame) { window.setFrame(r, display: false) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if fullscreen && !window.styleMask.contains(.fullScreen) { window.toggleFullScreen(nil) }
        sendWindowState()
    }

    func beginClose() {
        guard window.isVisible, !closing else { return }
        if window.styleMask.contains(.fullScreen) {
            // leave full screen first, then hand NCM the windowed frame
            closing = true
            window.toggleFullScreen(nil)
            return
        }
        closing = true
        let f = window.frame
        // winhelper.setWindowPosition takes a bottom-left origin, Cocoa's
        emit(["from": "host", "op": "closing", "frame": topLeftFrame(),
              "cocoa": ["x": f.minX, "y": f.minY, "w": f.width, "h": f.height]])
        // NCM is moved and raised by the injector, which then sends "hide"; don't wait forever
        closeTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in self?.finishClose() }
    }

    func finishClose() {
        closeTimer?.invalidate()
        guard window.isVisible else { closing = false; return }
        window.orderOut(nil)
        closing = false
        sendWindowState()
    }

    @objc func minimizeBoth() {
        emit(["from": "host", "op": "minimizing"])
        window.orderOut(nil)
        sendWindowState()
    }

    @objc func appActivated(_ n: Notification) {
        guard let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
              app.bundleIdentifier == NCM_BUNDLE_ID, window.isVisible, !closing else { return }
        // NCM came to the front (Dock, ⌘Tab) while its lyric page is showing: keep the page on top
        window.orderFrontRegardless()
    }

    func sendWindowState() {
        let b = web.bounds.size
        toWeb(["t": "host.window", "w": b.width, "h": b.height, "visible": window.isVisible,
               "fullscreen": window.styleMask.contains(.fullScreen)])
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
        if closing { closing = false; beginClose() }
    }

    func windowDidEnterFullScreen(_ n: Notification) { sendWindowState() }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { log("page loaded") }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        log("web content process terminated; reloading")
        pageReady = false
        webView.reload()
    }
}

let app = NSApplication.shared
let host = Host()
app.delegate = host
app.setActivationPolicy(.accessory) // no Dock icon: the window belongs to NCM as far as the user is concerned
app.run()
