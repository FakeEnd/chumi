// AppDelegate.swift — window, loading view, server lifecycle, main menu, desktop pet.

import AppKit
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private let server = ServerManager()
    private var web: WebController?
    private var chrome: WindowChrome!
    private var lastChrome: (CGFloat, Bool)?
    private var loadingView: NSView?
    private var statusLabel: NSTextField?
    private var quitting = false
    private var pet: PetPanel?
    private var petItem: NSMenuItem?

    // MARK: - Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = buildMainMenu()
        createWindow()
        showLoading("Starting Chumi…")
        NSApp.activate(ignoringOtherApps: true)

        server.onStatus = { [weak self] text in
            self?.statusLabel?.stringValue = text
        }
        server.onUnexpectedExit = { [weak self] status, tail in
            self?.serverDied(status: status, tail: tail)
        }
        startServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // The desktop pet is a visible window too, so check the main window itself.
        if !flag || !window.isVisible { window.makeKeyAndOrderFront(nil) }
        return true
    }

    /// Quitting stops the server we started. During a recording, ask first. Then stop the server off the main
    /// thread, because it can take several seconds to save the meeting.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard server.ownsRunningServer else { return .terminateNow }
        if quitting { return .terminateCancel }  // already asking or saving
        quitting = true
        let server = self.server
        DispatchQueue.global(qos: .userInitiated).async {
            let recording = server.isRecording()
            DispatchQueue.main.async { MainActor.assumeIsolated { self.finishQuit(recording: recording) } }
        }
        return .terminateLater
    }

    private func finishQuit(recording: Bool) {
        if recording {
            let alert = NSAlert()
            alert.messageText = "Save the meeting and quit?"
            alert.informativeText = "Chumi is recording. Quitting stops the recording and keeps everything captured so far. You can continue the meeting the next time you open Chumi."
            alert.addButton(withTitle: "Keep Recording")
            alert.addButton(withTitle: "Save and Quit")
            guard alert.runModal() == .alertSecondButtonReturn else {
                quitting = false
                NSApp.reply(toApplicationShouldTerminate: false)
                return
            }
            showLoading("Saving the meeting…")
        }
        let server = self.server
        DispatchQueue.global(qos: .userInitiated).async {
            server.stop()
            DispatchQueue.main.async { MainActor.assumeIsolated { NSApp.reply(toApplicationShouldTerminate: true) } }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        server.stop()  // normally a no-op: applicationShouldTerminate has already stopped the server
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    // MARK: - Window

    private func createWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1440, height: 900)
        window = NSWindow(contentRect: frame,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Chumi"  // hidden in the title bar; still used by the Window menu and Mission Control
        chrome = WindowChrome(window: window)
        window.minSize = NSSize(width: 1000, height: 640)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("ChumiMainWindow")
        window.makeKeyAndOrderFront(nil)
        chrome.layout()
    }

    // MARK: - Unified title bar

    private func relayoutChrome() {
        chrome.layout()
        let state = (chrome.trafficLightsInset, chrome.isFullScreen)
        if let last = lastChrome, last == state { return }
        lastChrome = state
        web?.setChrome(inset: state.0, fullScreen: state.1)
    }

    func windowDidResize(_ notification: Notification) { relayoutChrome() }
    func windowDidBecomeKey(_ notification: Notification) { chrome.layout() }
    func windowDidResignKey(_ notification: Notification) { chrome.layout() }
    func windowDidEnterFullScreen(_ notification: Notification) { relayoutChrome() }
    func windowDidExitFullScreen(_ notification: Notification) { relayoutChrome() }
    func windowDidChangeBackingProperties(_ notification: Notification) { relayoutChrome() }

    private func showLoading(_ text: String) {
        let container = NSView()
        container.wantsLayer = true

        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .regular
        spinner.isIndeterminate = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimation(nil)

        let title = NSTextField(labelWithString: "Chumi")
        title.font = .systemFont(ofSize: 28, weight: .semibold)
        title.translatesAutoresizingMaskIntoConstraints = false

        let label = NSTextField(wrappingLabelWithString: text)
        label.alignment = .center
        label.preferredMaxLayoutWidth = 520
        label.font = .systemFont(ofSize: 14)
        label.textColor = .secondaryLabelColor
        label.translatesAutoresizingMaskIntoConstraints = false
        statusLabel = label

        container.addSubview(title)
        container.addSubview(spinner)
        container.addSubview(label)
        NSLayoutConstraint.activate([
            title.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            title.bottomAnchor.constraint(equalTo: spinner.topAnchor, constant: -20),
            spinner.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            label.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            label.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 16),
        ])
        window.contentView = container
        loadingView = container
    }

    private func showWeb(_ url: URL) {
        let controller = web ?? WebController(baseURL: url)
        web = controller
        controller.onPetReset = { [weak self] in self?.pet?.resetPosition() }
        controller.onTopBar = { [weak self, weak controller] bar in
            guard let self, let controller else { return }
            self.chrome.barHeight = bar.maxY * controller.webView.pageZoom
            self.relayoutChrome()
        }
        window.contentView = controller.webView
        lastChrome = nil
        loadingView = nil
        controller.load(url)
        startPet(url)
    }

    // MARK: - Desktop pet

    private func startPet(_ url: URL) {
        let pet = self.pet ?? PetPanel()
        if self.pet == nil {
            pet.onOpen = { [weak self] session, t, t2, dialog in
                self?.showMainWindow()
                if let session { self?.web?.open(session: session, t: t, t2: t2, dialog: dialog) }
            }
            pet.onEnabled = { [weak self] on in self?.petItem?.state = on ? .on : .off }
            self.pet = pet
        }
        pet.load(url)
    }

    private func showMainWindow() {
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Settings → Desktop pet saves it; the pet page reports back and the menu follows (onEnabled).
    @objc func togglePet(_ sender: Any?) { pet?.toggle() }

    // MARK: - Server

    private func startServer() {
        server.start { [weak self] result in
            MainActor.assumeIsolated { self?.handle(result) }
        }
    }

    private func handle(_ result: ServerStartResult) {
        switch result {
        case .ready(let url, _):
            showWeb(url)
        case .failed(let message):
            statusLabel?.stringValue = "Chumi could not start."
            let alert = NSAlert()
            alert.alertStyle = .critical
            alert.messageText = "Chumi could not start its server"
            alert.informativeText = message
            alert.addButton(withTitle: "Quit")
            alert.addButton(withTitle: "Open Log")
            alert.addButton(withTitle: "Try Again")
            let response = alert.runModal()
            switch response {
            case .alertSecondButtonReturn:
                NSWorkspace.shared.open(server.logURL)
                NSApp.terminate(nil)
            case .alertThirdButtonReturn:
                showLoading("Starting Chumi…")
                server.restart { [weak self] r in MainActor.assumeIsolated { self?.handle(r) } }
            default:
                NSApp.terminate(nil)
            }
        }
    }

    private func serverDied(status: Int32, tail: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "The Chumi server stopped unexpectedly (status \(status))"
        alert.informativeText = "Last lines of \(server.logURL.path):\n\n\(tail)"
        alert.addButton(withTitle: "Restart Server")
        alert.addButton(withTitle: "Quit")
        if alert.runModal() == .alertFirstButtonReturn {
            showLoading("Restarting Chumi…")
            server.restart { [weak self] r in MainActor.assumeIsolated { self?.handle(r) } }
        } else {
            NSApp.terminate(nil)
        }
    }

    // MARK: - Menu actions

    @objc func reloadPage(_ sender: Any?) {
        if let web { web.reload() }
    }

    @objc func openInBrowser(_ sender: Any?) {
        NSWorkspace.shared.open(web?.webView.url ?? server.baseURL)
    }

    @objc func zoomIn(_ sender: Any?) { web.map { $0.webView.pageZoom = min(3, $0.webView.pageZoom + 0.1) }; lastChrome = nil; relayoutChrome() }
    @objc func zoomOut(_ sender: Any?) { web.map { $0.webView.pageZoom = max(0.5, $0.webView.pageZoom - 0.1) }; lastChrome = nil; relayoutChrome() }
    @objc func actualSize(_ sender: Any?) { web?.webView.pageZoom = 1; lastChrome = nil; relayoutChrome() }

    @objc func showServerLog(_ sender: Any?) {
        NSWorkspace.shared.open(server.logURL)
    }

    // MARK: - Main menu

    private func buildMainMenu() -> NSMenu {
        let main = NSMenu()

        // App menu
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "Chumi")
        appMenu.addItem(withTitle: "About Chumi", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        let services = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        let servicesMenu = NSMenu(title: "Services")
        services.submenu = servicesMenu
        NSApp.servicesMenu = servicesMenu
        appMenu.addItem(services)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Chumi", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Chumi", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        // Edit menu (needed for ⌘C/⌘V/⌘A inside the web view)
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        let pasteMatch = editMenu.addItem(withTitle: "Paste and Match Style", action: #selector(NSTextView.pasteAsPlainText(_:)), keyEquivalent: "v")
        pasteMatch.keyEquivalentModifierMask = [.command, .option, .shift]
        editMenu.addItem(withTitle: "Delete", action: #selector(NSText.delete(_:)), keyEquivalent: "")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        // View menu
        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        let reload = viewMenu.addItem(withTitle: "Reload", action: #selector(reloadPage(_:)), keyEquivalent: "r")
        reload.target = self
        let openBrowser = viewMenu.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser(_:)), keyEquivalent: "o")
        openBrowser.keyEquivalentModifierMask = [.command, .shift]
        openBrowser.target = self
        viewMenu.addItem(.separator())
        let actual = viewMenu.addItem(withTitle: "Actual Size", action: #selector(actualSize(_:)), keyEquivalent: "0")
        actual.target = self
        let zin = viewMenu.addItem(withTitle: "Zoom In", action: #selector(zoomIn(_:)), keyEquivalent: "+")
        zin.target = self
        let zout = viewMenu.addItem(withTitle: "Zoom Out", action: #selector(zoomOut(_:)), keyEquivalent: "-")
        zout.target = self
        viewMenu.addItem(.separator())
        let log = viewMenu.addItem(withTitle: "Show Server Log", action: #selector(showServerLog(_:)), keyEquivalent: "")
        log.target = self
        viewMenu.addItem(.separator())
        let fullScreen = viewMenu.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = viewMenu
        main.addItem(viewItem)

        // Window menu
        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        let petItem = windowMenu.addItem(withTitle: "Desktop Pet", action: #selector(togglePet(_:)), keyEquivalent: "")
        petItem.target = self
        petItem.state = .on  // until the pet page reports its setting
        self.petItem = petItem
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        return main
    }
}
