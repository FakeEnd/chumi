// PetPanel.swift — the desktop pet: a transparent panel that floats above other windows and shows pet.html (the
// character, its toolbar and the latest answers). It is as tall as the page says. Clicks land only on the character
// and the page's toolbar, cards and bubble (the page reports their boxes); elsewhere they pass through to the window
// below. The panel never takes focus, except while its ask box is open, so poking Chumi doesn't pull you out of Zoom.
// Whether it shows, its size and whether screen shares see it come from Settings → Desktop pet, through the page.

import AppKit
import WebKit

/// A borderless panel that can take the keyboard only when the page asks for it.
final class PetWindow: NSPanel {
    var allowsKey = false
    override var canBecomeKey: Bool { allowsKey }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class PetPanel: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    private static let topLeftKey = "ChumiPetTopLeft"
    /// The page's width in CSS px; the panel is this times the size from Settings.
    private static let pageWidth: CGFloat = 380

    /// Show Chumi's window, at a meeting and transcript time when the pet's card names one.
    var onOpen: ((_ session: String?, _ t: Double?, _ t2: Double?) -> Void)?
    /// The pet was turned on or off (Settings, its menu, Window → Desktop Pet).
    var onEnabled: ((Bool) -> Void)?
    private(set) var enabled = true

    private let panel: PetWindow
    /// An invisible 1-pt panel that takes the keyboard from the pet for a moment when the ask box closes (keyboard(false)).
    private let keySink: PetWindow
    private let webView: PetWebView
    private var baseURL: URL?
    private var ready = false
    private var zoom: CGFloat = 1
    private var timer: Timer?
    private var petRects: [CGRect] = []
    private var uiRects: [CGRect] = []
    /// The page's height in CSS px.
    private var height: CGFloat = 300
    /// Where the user put the panel (its top-left corner, screen coordinates). Growing cards extend it downwards,
    /// sliding it up only while they would not fit on the screen.
    private var topLeft: NSPoint
    private var lastPointer: CGPoint?
    private var lastRoom = 0
    private var down: (mouse: NSPoint, origin: NSPoint)?
    private var dragging = false
    private var lastDrag: (x: CGFloat, time: TimeInterval)?

    override init() {
        panel = PetWindow(contentRect: NSRect(x: 0, y: 0, width: Self.pageWidth, height: 300), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isMovable = false  // dragged by hand below, so a click and a drag can be told apart
        panel.isExcludedFromWindowsMenu = true
        panel.canHide = false  // ⌘H hides Chumi's window during a call; the pet stays
        panel.isReleasedWhenClosed = false
        panel.ignoresMouseEvents = true
        panel.sharingType = .none  // until the page says otherwise (Settings → Desktop pet)

        keySink = PetWindow(contentRect: NSRect(x: 0, y: 0, width: 1, height: 1), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        keySink.level = .floating
        keySink.collectionBehavior = panel.collectionBehavior  // never switches Spaces, even over a full-screen call
        keySink.alphaValue = 0
        keySink.ignoresMouseEvents = true
        keySink.hidesOnDeactivate = false
        keySink.animationBehavior = .none
        keySink.isExcludedFromWindowsMenu = true
        keySink.canHide = false
        keySink.isReleasedWhenClosed = false
        keySink.sharingType = .none

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        webView = PetWebView(frame: NSRect(x: 0, y: 0, width: Self.pageWidth, height: 300), configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear
        webView.autoresizingMask = [.width, .height]
        if let saved = UserDefaults.standard.array(forKey: Self.topLeftKey) as? [Double], saved.count == 2 {
            topLeft = NSPoint(x: saved[0], y: saved[1])
        } else {
            topLeft = .zero
        }
        super.init()
        config.userContentController.add(WeakScriptHandler(self), name: "chumiPet")
        webView.navigationDelegate = self
        webView.owner = self
        panel.contentView = webView
        if !onScreen(NSRect(x: topLeft.x, y: topLeft.y - 240, width: Self.pageWidth, height: 240)) { topLeft = defaultTopLeft() }
        place()
        // A display was unplugged or rearranged: bring Chumi back if it was left off screen.
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if !self.onScreen(self.panel.frame) { self.topLeft = self.defaultTopLeft() }
                self.place()
            }
        }
    }

    func load(_ base: URL) {
        baseURL = base
        ready = false
        webView.load(URLRequest(url: base.appendingPathComponent("pet.html")))
    }

    /// Window → Desktop Pet. The page saves it in Settings and reports back, which shows or hides the panel.
    func toggle() { js("setEnabled(\(!enabled))") }

    /// Settings → Desktop pet → Move it back to the corner.
    func resetPosition() {
        topLeft = defaultTopLeft()
        UserDefaults.standard.set([Double(topLeft.x), Double(topLeft.y)], forKey: Self.topLeftKey)
        place()
    }

    /// Shown once the page says it is the pet (an older server would answer pet.html with the main page) and is on.
    private func show() {
        guard ready, enabled else { return }
        panel.orderFrontRegardless()
        if timer == nil {
            let t = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.tick() } }
            RunLoop.main.add(t, forMode: .common)
            timer = t
        }
    }

    private func hide() {
        timer?.invalidate(); timer = nil
        keyboard(false)
        panel.orderOut(nil)
    }

    // MARK: - Page → app

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "chumiPet", let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "layout":
            func rects(_ v: Any?) -> [CGRect] {
                (v as? [[NSNumber]] ?? []).compactMap { a in
                    a.count == 4 ? CGRect(x: a[0].doubleValue, y: a[1].doubleValue, width: a[2].doubleValue, height: a[3].doubleValue) : nil
                }
            }
            petRects = rects(body["pet"])
            uiRects = rects(body["ui"])
            if let z = (body["zoom"] as? NSNumber)?.doubleValue, z >= 0.5, z <= 2, CGFloat(z) != zoom {
                zoom = CGFloat(z)
                webView.pageZoom = zoom
                place()
            }
            if let h = (body["height"] as? NSNumber)?.doubleValue, h > 50, abs(CGFloat(h) - height) >= 1 {
                height = min(CGFloat(h), 1400)
                place()
            }
            panel.sharingType = body["shareable"] as? Bool == true ? .readOnly : .none
            let on = body["enabled"] as? Bool ?? true
            if !ready { ready = true; lastRoom = 0; place() }  // the page has loaded: send it the room again
            if on != enabled { enabled = on; onEnabled?(on) }
            if enabled, !panel.isVisible { show() } else if !enabled, panel.isVisible { hide() }
        case "open":
            onOpen?(body["session"] as? String, (body["t"] as? NSNumber)?.doubleValue, (body["t2"] as? NSNumber)?.doubleValue)
        case "keyboard": keyboard(body["on"] as? Bool ?? false)
        default: break
        }
    }

    private func js(_ code: String) { webView.evaluateJavaScript("window.chumiPet && chumiPet.\(code)", completionHandler: nil) }

    /// The ask box: let the panel take the keyboard, then hand it back to the app underneath.
    private func keyboard(_ on: Bool) {
        if on {
            panel.allowsKey = true
            panel.makeKey()
        } else {
            panel.allowsKey = false
            // Ordering the key window out is what hands the keyboard back. The pet itself would fade out and in (a
            // fifth of a second without it), so the invisible sink takes the keyboard and is ordered out instead.
            guard panel.isKeyWindow, enabled else { return }  // hide() orders the pet out itself
            keySink.setFrameOrigin(panel.frame.origin)
            keySink.allowsKey = true
            keySink.orderFrontRegardless()
            keySink.makeKey()
            keySink.orderOut(nil)
            keySink.allowsKey = false
        }
    }

    // MARK: - Cursor: eyes follow it, and clicks pass through except over the pet and its boxes

    /// A screen point in the page's CSS px (top-left origin).
    private func pagePoint(_ screen: NSPoint) -> CGPoint {
        let f = panel.frame
        return CGPoint(x: (screen.x - f.minX) / zoom, y: (f.maxY - screen.y) / zoom)
    }

    fileprivate func isUI(_ p: CGPoint) -> Bool { uiRects.contains { $0.contains(p) } }

    private func tick() {
        let p = pagePoint(NSEvent.mouseLocation)
        if !dragging {
            let over = isUI(p) || petRects.contains { $0.contains(p) }
            if panel.ignoresMouseEvents == over { panel.ignoresMouseEvents = !over }
        }
        if p != lastPointer {
            lastPointer = p
            js("pointer(\(Int(p.x)), \(Int(p.y)))")
        }
    }

    fileprivate func point(of event: NSEvent) -> CGPoint { pagePoint(NSEvent.mouseLocation) }

    // MARK: - Mouse on the character (forwarded by PetWebView; the boxes get normal web clicks)

    fileprivate func mouseDown(_ event: NSEvent) {
        if event.modifierFlags.contains(.control) { down = nil; rightMouseDown(event); return }  // control-click = right-click
        down = (NSEvent.mouseLocation, panel.frame.origin)
        dragging = false
    }

    fileprivate func mouseDragged(_ event: NSEvent) {
        guard let down else { return }
        let m = NSEvent.mouseLocation, dx = m.x - down.mouse.x, dy = m.y - down.mouse.y
        if !dragging {
            guard hypot(dx, dy) >= 4 else { return }
            dragging = true
            js("drag('start')")
        }
        panel.setFrameOrigin(NSPoint(x: down.origin.x + dx, y: down.origin.y + dy))
        var vx: CGFloat = 0
        if let last = lastDrag, event.timestamp > last.time { vx = (m.x - last.x) / CGFloat(event.timestamp - last.time) }
        lastDrag = (m.x, event.timestamp)
        js("drag('move', \(Int(vx)))")
    }

    fileprivate func mouseUp(_ event: NSEvent) {
        guard down != nil else { return }  // a control-click opened the menu instead
        defer { down = nil; lastDrag = nil }
        if dragging {
            dragging = false
            topLeft = NSPoint(x: panel.frame.minX, y: panel.frame.maxY)
            place()
            topLeft = NSPoint(x: panel.frame.minX, y: panel.frame.maxY)
            UserDefaults.standard.set([Double(topLeft.x), Double(topLeft.y)], forKey: Self.topLeftKey)
            js("drag('end')")
            return
        }
        let p = pagePoint(NSEvent.mouseLocation)
        js("click(\(Int(p.x)), \(Int(p.y)), \(event.clickCount))")
    }

    /// The page builds the menu, so its labels follow Chumi's interface language.
    fileprivate func rightMouseDown(_ event: NSEvent) {
        let at = webView.convert(event.locationInWindow, from: nil)
        webView.evaluateJavaScript("chumiPet.menu()") { [weak self] result, _ in
            MainActor.assumeIsolated {
                guard let self, let json = result as? String, let data = json.data(using: .utf8),
                      let items = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return }
                let menu = NSMenu()
                menu.autoenablesItems = false
                for item in items {
                    let id = item["id"] as? String ?? ""
                    if id == "-" { menu.addItem(.separator()); continue }
                    let mi = NSMenuItem(title: item["label"] as? String ?? id, action: #selector(self.menuAction(_:)), keyEquivalent: "")
                    mi.target = self
                    mi.representedObject = id
                    mi.isEnabled = item["enabled"] as? Bool ?? true
                    menu.addItem(mi)
                }
                menu.popUp(positioning: nil, at: at, in: self.webView)
            }
        }
    }

    @objc private func menuAction(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, id.allSatisfy({ $0.isLetter }) else { return }
        js("run('\(id)')")
    }

    // MARK: - Placement

    /// Bottom-right of the main screen, with room for the toolbar and a card under the pet.
    private func defaultTopLeft() -> NSPoint {
        let vf = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        return NSPoint(x: vf.maxX - Self.pageWidth * zoom - 8, y: vf.minY + 470 * zoom)
    }

    private func onScreen(_ frame: NSRect) -> Bool { NSScreen.screens.contains { $0.visibleFrame.intersects(frame.insetBy(dx: 60, dy: 40)) } }

    /// The panel at `topLeft` with the page's height, moved just enough to stay on the screen it is on.
    private func place() {
        let w = Self.pageWidth * zoom, h = height * zoom
        var f = NSRect(x: topLeft.x, y: topLeft.y - h, width: w, height: h)
        let center = NSPoint(x: f.midX, y: f.maxY - 160 * zoom)  // the pet
        if let vf = (NSScreen.screens.first { $0.frame.contains(center) } ?? NSScreen.main)?.visibleFrame {
            // Tell the page how far down it may grow from where the user put it, so a long list of cards stops at the
            // bottom of the screen instead of pushing the pet up.
            let room = Int(max(420, (topLeft.y - vf.minY) / zoom))
            if room != lastRoom { lastRoom = room; js("room(\(room))") }
            f.origin.x = min(max(f.minX, vf.minX - 60), vf.maxX - f.width + 60)
            if f.minY < vf.minY { f.origin.y = vf.minY }
            if f.maxY > vf.maxY + 60 * zoom { f.origin.y = vf.maxY + 60 * zoom - f.height }  // the empty bubble space may go above the top
        }
        if panel.frame != f { panel.setFrame(f, display: true) }
    }

    // MARK: - Navigation: the panel only ever shows the pet page

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let ours = url?.host == baseURL?.host && url?.port == baseURL?.port && url?.path == "/pet.html"
        decisionHandler(ours || navigationAction.targetFrame?.isMainFrame == false ? .allow : .cancel)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if let baseURL { load(baseURL) }
    }
}

/// Clicks on the character drag the panel or tap the pet; clicks on the page's toolbar, cards and bubble are normal web
/// clicks (buttons, text selection, scrolling).
final class PetWebView: WKWebView {
    fileprivate weak var owner: PetPanel?
    private var webDrag = false

    private func onUI(_ event: NSEvent) -> Bool { owner?.isUI(owner?.point(of: event) ?? .zero) ?? false }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        webDrag = onUI(event) && !event.modifierFlags.contains(.control)
        if webDrag { super.mouseDown(with: event) } else { owner?.mouseDown(event) }
    }
    override func mouseDragged(with event: NSEvent) { if webDrag { super.mouseDragged(with: event) } else { owner?.mouseDragged(event) } }
    override func mouseUp(with event: NSEvent) {
        if webDrag { webDrag = false; super.mouseUp(with: event) } else { owner?.mouseUp(event) }
    }
    override func rightMouseDown(with event: NSEvent) { owner?.rightMouseDown(event) }
    override func scrollWheel(with event: NSEvent) { if onUI(event) { super.scrollWheel(with: event) } }
}
