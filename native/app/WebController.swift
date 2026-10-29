// WebController.swift — WKWebView hosting the local Chumi UI: JS panels, external links,
// downloads to ~/Downloads, file inputs.

import AppKit
import WebKit

@MainActor
final class WebController: NSObject, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    let webView: ChumiWebView
    /// Called when the page reports its top bar (CSS px), so the window chrome can follow it.
    var onTopBar: ((CGRect) -> Void)?
    /// Settings → Desktop pet → Move it back to the corner.
    var onPetReset: (() -> Void)?
    private(set) var baseURL: URL
    private var downloadDestinations: [ObjectIdentifier: URL] = [:]

    init(baseURL: URL) {
        self.baseURL = baseURL
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        config.websiteDataStore = .default()
        // Tell the page it runs inside Chumi.app with a unified title bar (before first paint, so nothing jumps).
        config.userContentController.addUserScript(WKUserScript(
            source: "document.documentElement.dataset.shell='mac';document.documentElement.style.setProperty('--traffic-inset','86px');",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = ChumiWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.add(WeakScriptHandler(self), name: "chumiShell")
        webView.uiDelegate = self
        webView.navigationDelegate = self
        #if CHUMI_DEV
        webView.isInspectable = true  // dev builds only: CHUMI_DEV=1 bash native/build.sh
        #endif
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = true
        webView.customUserAgent = nil
    }

    /// Page → app: {type: 'topbar', bar: [x, y, w, h], noDrag: [[x, y, w, h], …]} in CSS px, or {type: 'pet-reset'}.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "chumiShell", let body = message.body as? [String: Any] else { return }
        if body["type"] as? String == "pet-reset" { onPetReset?(); return }
        guard body["type"] as? String == "topbar" else { return }
        func rect(_ v: Any?) -> CGRect? {
            guard let a = v as? [NSNumber], a.count == 4 else { return nil }
            return CGRect(x: a[0].doubleValue, y: a[1].doubleValue, width: a[2].doubleValue, height: a[3].doubleValue)
        }
        guard let bar = rect(body["bar"]) else { return }
        webView.dragBar = bar
        webView.noDrag = (body["noDrag"] as? [Any] ?? []).compactMap(rect)
        onTopBar?(bar)
    }

    /// App → page: where the traffic lights end, and whether the window is full screen.
    func setChrome(inset: CGFloat, fullScreen: Bool) {
        let px = Int((inset / max(0.25, webView.pageZoom)).rounded())
        webView.evaluateJavaScript("document.documentElement.style.setProperty('--traffic-inset','\(px)px');document.documentElement.dataset.fullscreen='\(fullScreen ? 1 : 0)';", completionHandler: nil)
    }

    /// App → page: open a meeting, optionally at a transcript time (from the desktop pet's cards).
    func open(session: String, t: Double?, t2: Double?, dialog: String? = nil) {
        var args: [String: Any] = ["session": session]
        if let t { args["t"] = t }
        if let t2 { args["t2"] = t2 }
        if dialog == "handoff" { args["dialog"] = dialog }
        guard let data = try? JSONSerialization.data(withJSONObject: args), let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.chumiOpen && chumiOpen(\(json))", completionHandler: nil)
    }

    func load(_ url: URL) {
        baseURL = url
        webView.load(URLRequest(url: url))
    }

    func reload() {
        if webView.url == nil { load(baseURL) } else { webView.reload() }
    }

    private var window: NSWindow? { webView.window }

    /// Chumi's own server (127.0.0.1 or localhost on its port), or an about:/blob:/data: document the page made.
    private func isAppURL(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return ["about", "blob", "data"].contains(url.scheme?.lowercased() ?? "") }
        return url.scheme?.lowercased() == "http" && (host == "127.0.0.1" || host == "localhost") && url.port == baseURL.port
    }

    /// Only web and mail links leave the app, as in the Windows shell. Other schemes (file:, app URL schemes…) are dropped.
    private func openExternally(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else { return }
        NSWorkspace.shared.open(url)
    }

    // MARK: - Navigation policy

    /// Match only the composer and saved-chat links Chumi creates, never settings, plugins or other actions.
    nonisolated static func isAllowedCodexURL(_ url: URL) -> Bool {
        let raw = url.absoluteString
        if raw.range(of: #"^codex://threads/[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil { return true }
        guard raw.hasPrefix("codex://new?"),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme == "codex", components.host == "new", components.path.isEmpty,
              components.user == nil, components.password == nil, components.port == nil,
              components.fragment == nil, let query = components.percentEncodedQuery else { return false }
        // Decode URLSearchParams form encoding (including '+') before checking names and empty values.
        let pairs = query.split(separator: "&", omittingEmptySubsequences: false)
        guard pairs.count == 2 else { return false }
        var keys = Set<String>()
        for pair in pairs {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2,
                  let key = String(parts[0]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                  let value = String(parts[1]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                  key == "path" || key == "prompt", keys.insert(key).inserted,
                  !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        }
        return true
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, url.scheme?.lowercased() == "codex" {
            if Self.isAllowedCodexURL(url) && (navigationAction.targetFrame?.isMainFrame ?? true) {
                NSWorkspace.shared.open(url)
            }
            // Unsupported Codex actions are also cancelled, so WKWebView never attempts to load them.
            decisionHandler(.cancel)
            return
        }
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        // The window only ever shows Chumi itself: any other main-frame navigation is cancelled, and web or mail
        // links open outside the app. New windows (no target frame) go through createWebViewWith.
        if let url = navigationAction.request.url, navigationAction.targetFrame?.isMainFrame == true, !isAppURL(url) {
            openExternally(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        if let http = navigationResponse.response as? HTTPURLResponse,
           let disposition = http.value(forHTTPHeaderField: "Content-Disposition"),
           disposition.lowercased().contains("attachment") {
            decisionHandler(.download)
            return
        }
        if !navigationResponse.canShowMIMEType {
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return }  // frame load interrupted (download)
        let html = """
        <html><body style="font: 14px -apple-system; padding: 40px; color: #444">
        <h2>Could not load Chumi</h2><p>\(ns.localizedDescription)</p>
        <p>Use View → Reload (⌘R) to try again.</p></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: - New windows (target=_blank / window.open)

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        switch url.scheme?.lowercased() {
        case "blob", "data":
            webView.startDownload(using: navigationAction.request) { [weak self] download in
                download.delegate = self
            }
        case "codex":
            if Self.isAllowedCodexURL(url) { NSWorkspace.shared.open(url) }
        default:
            openExternally(url)
        }
        return nil
    }

    // MARK: - JavaScript panels

    private func present(_ alert: NSAlert, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        if let window {
            alert.beginSheetModal(for: window, completionHandler: completion)
        } else {
            completion(alert.runModal())
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        present(alert) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        present(alert) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        present(alert) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        let handler: (NSApplication.ModalResponse) -> Void = { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
        if let window {
            panel.beginSheetModal(for: window, completionHandler: handler)
        } else {
            handler(panel.runModal())
        }
    }

    // MARK: - Downloads

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping @MainActor (URL?) -> Void) {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads")
        try? FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        let dest = WebController.uniqueURL(in: downloads, for: suggestedFilename)
        downloadDestinations[ObjectIdentifier(download)] = dest
        completionHandler(dest)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let url = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadDestinations.removeValue(forKey: ObjectIdentifier(download))
        let alert = NSAlert()
        alert.messageText = "Download failed"
        alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: "OK")
        present(alert) { _ in }
    }

    static func uniqueURL(in dir: URL, for suggested: String) -> URL {
        var name = suggested
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty || name == "." || name == ".." { name = "download" }
        let ns = name as NSString
        let ext = ns.pathExtension
        let base = ext.isEmpty ? name : ns.deletingPathExtension
        var candidate = dir.appendingPathComponent(name)
        var i = 1
        while FileManager.default.fileExists(atPath: candidate.path) {
            let numbered = ext.isEmpty ? "\(base) (\(i))" : "\(base) (\(i)).\(ext)"
            candidate = dir.appendingPathComponent(numbered)
            i += 1
        }
        return candidate
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle with WebController.
final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
