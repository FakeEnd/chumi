// ServerManager.swift — finds node, picks a port, runs `node server/main.ts`, waits for /api/health.

import Foundation
import Darwin

enum ServerStartResult {
    case ready(URL, owned: Bool)
    case failed(String)
}

final class ServerManager: @unchecked Sendable {
    static let defaultPort = 4777
    static let lastPort = 4790
    /// The child uses this same total budget for saving the session and stopping its workers.
    static let shutdownGraceMilliseconds = 15_000
    static let shutdownExitMarginSeconds: TimeInterval = 2

    private(set) var port = ServerManager.defaultPort
    private(set) var ownsServer = false
    private var process: Process?
    private var stdinPipe: Pipe?
    private var intentionalStop = false
    private let lock = NSLock()

    /// Progress text for the loading view (called on the main queue).
    var onStatus: ((String) -> Void)?

    /// Called on the main queue when a server we started exits on its own after becoming ready.
    var onUnexpectedExit: ((_ status: Int32, _ logTail: String) -> Void)?

    let logURL: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Chumi", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("server.log")
    }()

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    /// True while the server this app started is running (quitting then stops it).
    var ownsRunningServer: Bool {
        lock.lock()
        defer { lock.unlock() }
        return ownsServer && process?.isRunning == true
    }

    // MARK: - Paths

    var repoPath: String {
        if let p = Bundle.main.object(forInfoDictionaryKey: "ChumiRepoPath") as? String, !p.isEmpty,
           FileManager.default.fileExists(atPath: p) {
            return p
        }
        if let env = ProcessInfo.processInfo.environment["CHUMI_REPO"], !env.isEmpty { return env }
        // Fallback: <repo>/build/Chumi.app
        return Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().path
    }

    var helperPath: String {
        Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/chumi-audio").path
    }

    /// The server needs Node 24 or later (package.json "engines"; scripts/setup.sh checks the same).
    static let minimumNodeMajor = 24

    /// Versions older than `minimumNodeMajor` are skipped.
    static func findNode(recorded: String? = Bundle.main.object(forInfoDictionaryKey: "ChumiNodePath") as? String,
                         home: URL = FileManager.default.homeDirectoryForCurrentUser,
                         brewPaths: [String] = ["/opt/homebrew/bin/node", "/usr/local/bin/node"],
                         shellOutput: () -> String? = { output(of: "/bin/zsh", ["-ilc", "command -v node"], timeout: 8) }) -> String? {
        let fm = FileManager.default
        func usable(_ path: String) -> Bool {
            path.hasPrefix("/") && fm.isExecutableFile(atPath: path) && isRecentNode(path)
        }
        if let recorded, usable(recorded) { return recorded }
        if let brew = brewPaths.first(where: usable) { return brew }
        // Interactive login shells read both ~/.zprofile and ~/.zshrc.
        if let out = shellOutput(), let path = out.split(separator: "\n").map({ $0.trimmingCharacters(in: .whitespaces) }).last(where: { $0.hasPrefix("/") }), usable(path) { return path }

        func versions(_ directory: String, _ suffix: String) -> [String] {
            let root = home.appendingPathComponent(directory, isDirectory: true)
            let names = (try? fm.contentsOfDirectory(atPath: root.path)) ?? []
            return names.sorted { $0.compare($1, options: .numeric) == .orderedDescending }.map { root.appendingPathComponent($0).appendingPathComponent(suffix).path }
        }
        let candidates = versions(".nvm/versions/node", "bin/node")
            + versions(".local/share/fnm/node-versions", "installation/bin/node")
            + versions("Library/Application Support/fnm/node-versions", "installation/bin/node")
            + [".volta/bin/node", ".local/share/mise/shims/node", ".asdf/shims/node"].map { home.appendingPathComponent($0).path }
        return candidates.first(where: usable)
    }

    static func serverPath(node: String, inherited: String?) -> String {
        (node as NSString).deletingLastPathComponent + ":/opt/homebrew/bin:/usr/local/bin:" + (inherited ?? "/usr/bin:/bin:/usr/sbin:/sbin")
    }

    /// `node --version` prints e.g. "v24.1.0".
    static func isRecentNode(_ path: String) -> Bool {
        guard let version = output(of: path, ["--version"], timeout: 5)?.trimmingCharacters(in: .whitespacesAndNewlines),
              version.hasPrefix("v"), let major = Int(version.dropFirst().prefix { $0.isNumber }) else { return false }
        return major >= minimumNodeMajor
    }

    /// Runs a program and returns its stdout, or nil if it cannot start or runs past the timeout.
    static func output(of executable: String, _ arguments: [String], timeout: TimeInterval) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: executable)
        p.arguments = arguments
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning { p.terminate(); return nil }
        return String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    }

    // MARK: - Health / ports

    /// GET /api/health with a short timeout. Returns (HTTP status, parsed JSON object) or nil.
    static func health(port: Int, timeout: TimeInterval = 1.0) -> (Int, [String: Any]?)? {
        get(port: port, path: "/api/health", timeout: timeout)
    }

    /// GET a JSON endpoint of the local server with a short timeout. Returns (HTTP status, parsed JSON object) or nil.
    static func get(port: Int, path: String, timeout: TimeInterval) -> (Int, [String: Any]?)? {
        guard let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { return nil }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.httpMethod = "GET"
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        config.connectionProxyDictionary = [:]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let sem = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var result: (Int, [String: Any]?)?
        session.dataTask(with: req) { data, response, _ in
            if let http = response as? HTTPURLResponse {
                let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
                result = (http.statusCode, json)
            }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + timeout + 0.5)
        return result
    }

    static func isChumi(_ h: (Int, [String: Any]?)?) -> Bool {
        guard let h, h.0 == 200, let app = h.1?["app"] as? String else { return false }
        return app.lowercased() == "chumi"
    }

    /// True if something accepts connections on 127.0.0.1:port or the port cannot be bound.
    static func portBusy(_ port: Int) -> Bool {
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port).bigEndian)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        // Something listening (IPv4, or dual-stack IPv6 wildcard)?
        let c = socket(AF_INET, SOCK_STREAM, 0)
        if c >= 0 {
            let connected = withUnsafePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(c, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
            } == 0
            close(c)
            if connected { return true }
        }
        // Can we bind it?
        let s = socket(AF_INET, SOCK_STREAM, 0)
        guard s >= 0 else { return true }
        defer { close(s) }
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        } == 0
        return !bound
    }

    // MARK: - Start / stop

    /// Connects to an existing Chumi server on 4777 or starts one. Completion is called on the main queue.
    func start(completion: @escaping @Sendable (ServerStartResult) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let result = self.startBlocking()
            DispatchQueue.main.async { completion(result) }
        }
    }

    private func startBlocking() -> ServerStartResult {
        // Reuse a server that's already running (e.g. `npm run dev` in a terminal).
        if ServerManager.isChumi(ServerManager.health(port: ServerManager.defaultPort)) {
            port = ServerManager.defaultPort
            ownsServer = false
            appendLog("=== \(Date()) Chumi.app connected to an already-running server on port \(port)\n")
            return .ready(baseURL, owned: false)
        }

        let repo = repoPath
        let mainTS = (repo as NSString).appendingPathComponent("server/main.ts")
        guard FileManager.default.fileExists(atPath: mainTS) else {
            return .failed("The Chumi server was not found at:\n\(mainTS)\n\nRebuild the app with native/build.sh from the repository, or set ChumiRepoPath in Chumi.app/Contents/Info.plist.")
        }
        // If the repo is in a privacy-protected folder (~/Documents, ~/Desktop, iCloud Drive), macOS asks
        // once whether Chumi may access it. Trigger that here (off the main thread) so node does not stall
        // on it during the health-check window.
        let slowNotice = DispatchWorkItem { [weak self] in
            self?.onStatus?("Waiting for permission to access \((repo as NSString).abbreviatingWithTildeInPath)…\nIf macOS asks whether Chumi may access this folder, choose Allow.")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: slowNotice)
        let readable = FileHandle(forReadingAtPath: mainTS).map { h -> Bool in
            defer { try? h.close() }
            return (try? h.read(upToCount: 1)) != nil
        } ?? false
        slowNotice.cancel()
        DispatchQueue.main.async { [weak self] in self?.onStatus?("Starting Chumi…") }
        guard readable else {
            return .failed("Chumi cannot read its server files in:\n\(repo)\n\nAllow access in System Settings → Privacy & Security → Files and Folders → Chumi, then reopen Chumi.")
        }

        guard let node = ServerManager.findNode() else {
            return .failed("Chumi needs Node.js \(ServerManager.minimumNodeMajor) or later and did not find it (looked in the recorded build path, Homebrew, your login shell PATH and common version-manager locations; older versions are skipped).\n\nInstall a current Node.js (e.g. `brew install node`) and reopen Chumi.")
        }
        guard let chosen = (ServerManager.defaultPort...ServerManager.lastPort).first(where: { !ServerManager.portBusy($0) }) else {
            return .failed("No free port between \(ServerManager.defaultPort) and \(ServerManager.lastPort) on 127.0.0.1.")
        }
        port = chosen

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [mainTS]
        p.currentDirectoryURL = URL(fileURLWithPath: repo)
        var env = ProcessInfo.processInfo.environment
        env["CHUMI_APP"] = "1"
        env["CHUMI_SHUTDOWN_GRACE_MS"] = String(ServerManager.shutdownGraceMilliseconds)
        env["CHUMI_AUDIO_HELPER"] = helperPath
        env["PORT"] = String(chosen)
        env["PATH"] = ServerManager.serverPath(node: node, inherited: env["PATH"])
        p.environment = env

        let fd = open(logURL.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        guard fd >= 0 else { return .failed("Could not open the log file \(logURL.path).") }
        let logHandle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        logHandle.write("\n=== \(Date()) Chumi.app starting: \(node) \(mainTS) (PORT=\(chosen))\n".data(using: .utf8)!)
        p.standardOutput = logHandle
        p.standardError = logHandle
        // The server's stdin stays open for as long as the app lives; EOF means the app went away.
        let input = Pipe()
        p.standardInput = input

        p.terminationHandler = { [weak self] proc in
            guard let self else { return }
            // restart() may have reset intentionalStop before the old process's handler runs, so a process this
            // manager no longer tracks also counts as stopped on purpose.
            self.lock.lock()
            let intentional = self.intentionalStop || proc !== self.process
            self.lock.unlock()
            let status = proc.terminationStatus
            self.appendLog("=== \(Date()) server exited with status \(status)\(intentional ? " (requested)" : "")\n")
            if !intentional {
                let tail = self.logTail()
                DispatchQueue.main.async { self.onUnexpectedExit?(status, tail) }
            }
        }

        do {
            try p.run()
        } catch {
            return .failed("Could not start node: \(error.localizedDescription)")
        }
        lock.lock()
        process = p
        stdinPipe = input
        ownsServer = true
        intentionalStop = false
        lock.unlock()

        // Wait for health (every 250 ms, up to 30 s).
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            if !p.isRunning {
                return .failed("The Chumi server exited during startup (status \(p.terminationStatus)).\n\nLast lines of \(logURL.path):\n\n\(logTail())")
            }
            if let h = ServerManager.health(port: chosen, timeout: 0.8), h.0 == 200 {
                return .ready(baseURL, owned: true)
            }
            usleep(250_000)
        }
        return .failed("The Chumi server did not become ready within 30 seconds.\n\nLast lines of \(logURL.path):\n\n\(logTail())")
    }

    /// True if the server we started is recording a meeting. Asks with a short timeout; false if it does not answer.
    func isRecording() -> Bool {
        guard ownsRunningServer,
              let live = ServerManager.get(port: port, path: "/api/state", timeout: 2)?.1?["live"] as? [String: Any] else { return false }
        return live["status"] as? String == "recording"
    }

    /// A normal child exit acknowledges that its bounded shutdown and database close have finished.
    /// Never force-kill inside the child's save budget; allow a small exit/reaping margin after it.
    @discardableResult
    static func stopOwnedProcess(_ p: Process, timeout: TimeInterval = TimeInterval(shutdownGraceMilliseconds) / 1000 + shutdownExitMarginSeconds) -> Bool {
        guard p.isRunning else { return true }
        let pid = p.processIdentifier
        kill(pid, SIGTERM)
        // Wall-clock adjustments must not shorten a save or make shutdown unbounded.
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        while p.isRunning && ProcessInfo.processInfo.systemUptime < deadline { usleep(50_000) }
        guard p.isRunning else { return true }
        kill(pid, SIGKILL)
        usleep(100_000)
        return false
    }

    /// Stop only the child we own; an existing terminal-launched server belongs to its caller.
    func stop() {
        lock.lock()
        let p = process
        let owned = ownsServer
        let input = stdinPipe
        intentionalStop = true
        lock.unlock()
        guard owned, let p else { return }
        if !ServerManager.stopOwnedProcess(p) {
            appendLog("=== \(Date()) server exceeded its shutdown budget; forced termination\n")
        }
        try? input?.fileHandleForWriting.close()
    }

    func restart(completion: @escaping @Sendable (ServerStartResult) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            self.stop()
            self.lock.lock()
            self.process = nil
            self.intentionalStop = false
            self.lock.unlock()
            let result = self.startBlocking()
            DispatchQueue.main.async { completion(result) }
        }
    }

    // MARK: - Log helpers

    func appendLog(_ text: String) {
        let fd = open(logURL.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        guard fd >= 0 else { return }
        defer { close(fd) }
        let bytes = Array(text.utf8)
        _ = bytes.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
    }

    func logTail(lines: Int = 25) -> String {
        guard let handle = try? FileHandle(forReadingFrom: logURL) else { return "(log unavailable)" }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let start = size > 16384 ? size - 16384 : 0
        try? handle.seek(toOffset: start)
        let data = (try? handle.readToEnd()) ?? Data()
        let text = String(decoding: data, as: UTF8.self)
        return text.split(separator: "\n", omittingEmptySubsequences: false).suffix(lines).joined(separator: "\n")
    }
}
