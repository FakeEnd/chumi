// WindowChrome.swift — unified title bar. The macOS title is hidden and the title bar is transparent,
// so the page's own top bar fills that row. The traffic-light buttons are centred in the top bar,
// and empty parts of the top bar drag the window (WKWebView has no CSS drag regions).

import AppKit
import WebKit

@MainActor
final class WindowChrome {
    private weak var window: NSWindow?
    /// Height of the page's top bar in points. Default matches the CSS top bar before the page reports.
    var barHeight: CGFloat = 52
    private let leftMargin: CGFloat = 18

    init(window: NSWindow) {
        self.window = window
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.styleMask.insert(.fullSizeContentView)
    }

    var isFullScreen: Bool { window?.styleMask.contains(.fullScreen) ?? false }

    /// Centre the close / minimise / zoom buttons vertically in the page's top bar.
    /// AppKit resets their frames on some window events, so this runs after resizes, focus changes and page reports.
    func layout() {
        guard let window, !isFullScreen,
              let close = window.standardWindowButton(.closeButton),
              let mini = window.standardWindowButton(.miniaturizeButton),
              let zoom = window.standardWindowButton(.zoomButton),
              let container = close.superview?.superview else { return }
        let h = max(barHeight, close.frame.height + 8).rounded()
        var f = container.frame
        if f.height != h || f.origin.y != window.frame.height - h {
            f.size.height = h
            f.origin.y = window.frame.height - h
            container.frame = f
        }
        let spacing = max(20, mini.frame.minX - close.frame.minX)
        for (i, button) in [close, mini, zoom].enumerated() {
            let origin = NSPoint(x: leftMargin + CGFloat(i) * spacing, y: ((h - button.frame.height) / 2).rounded())
            if button.frame.origin != origin { button.setFrameOrigin(origin) }
        }
    }

    /// Space the page must leave on the left of its top bar for the buttons, in points.
    var trafficLightsInset: CGFloat {
        guard !isFullScreen, let zoom = window?.standardWindowButton(.zoomButton) else { return 0 }
        return zoom.frame.maxX + 16
    }

    /// What a double-click on the title bar does, per System Settings → Desktop & Dock.
    static func titleBarDoubleClick(_ window: NSWindow) {
        let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick")
        switch action {
        case "Minimize": window.miniaturize(nil)
        case "None": break
        default: window.zoom(nil)
        }
    }
}

/// WKWebView that turns clicks on empty parts of the page's top bar into window drags.
final class ChumiWebView: WKWebView {
    /// Reported by the page (CSS px, viewport coordinates): the top bar and the controls inside it.
    var dragBar: CGRect = .zero
    var noDrag: [CGRect] = []

    override func mouseDown(with event: NSEvent) {
        if let window, isDragArea(event) {
            if event.clickCount >= 2 { WindowChrome.titleBarDoubleClick(window) } else { window.performDrag(with: event) }
            return
        }
        super.mouseDown(with: event)
    }

    private func isDragArea(_ event: NSEvent) -> Bool {
        let p = convert(event.locationInWindow, from: nil)
        let scale = pageZoom * magnification
        return isDragPoint(CGPoint(x: p.x / scale, y: (isFlipped ? p.y : bounds.height - p.y) / scale))
    }

    /// `point` in CSS px from the top-left of the page.
    func isDragPoint(_ point: CGPoint) -> Bool {
        guard dragBar.height > 0 else { return false }
        return dragBar.contains(point) && !noDrag.contains { $0.insetBy(dx: -3, dy: -3).contains(point) }
    }
}
