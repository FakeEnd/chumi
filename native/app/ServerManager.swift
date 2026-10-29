// ServerManager.swift — finds node, picks a port, runs `node server/main.ts`, waits for /api/health.

import Foundation
import Darwin

enum ServerStartResult {
    case ready(URL, owned: Bool)
    case failed(String)
}

enum QuitCheck {
    case idle, active, finishing, unknown

    static func parse(_ response: (Int, [String: Any]?)?) -> QuitCheck {
        guard let response, response.0 == 200, let json = response.1,
              let status = json["status"] as? String,
              let outputs = json["pendingOutputs"] as? Int, outputs >= 0,
              let handoff = json["handoffGenerating"] as? Bool,
              let summaries = json["pendingSummaries"] as? Int, summaries >= 0 else { return .unknown }
        if ["recording", "paused", "starting"].contains(status) { return .active }
        if status == "ending" || outputs > 0 || handoff || summaries > 0 { return .finishing }
        return status == "idle" ? .idle : .unknown
    }
}

/// Accessed under ServerManager's lock, including from process termination callbacks.
struct ServerLifecycle {
    private(set) var starting = false
    private(set) var readyProcess: Process?

    mutating func beginStart() -> Bool {
        guard !starting else { return false }
        starting = true
        readyProcess = nil
        return true
    }

    mutating func finishStart() { starting = false }
    mutating func markReady(_ process: Process) { readyProcess = process }
    mutating func stop() { readyProcess = nil }

    func shouldReportExit(_ process: Process) -> Bool { !starting && process === readyProcess }

    func quitCheck(for process: Process?, fetch: () -> (Int, [String: Any]?)?) -> QuitCheck {
        guard let process, process === readyProcess else { return .idle }
        return QuitCheck.parse(fetch())
    }
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
    private var lifecycle = ServerLifecycle()
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

    static func dataDirectory(environment: [String: String], home: URL, repo: String) -> URL {
        if let path = environment["CHUMI_DATA_DIR"], !path.isEmpty {
            return URL(fileURLWithPath: path, relativeTo: URL(fileURLWithPath: repo, isDirectory: true)).standardizedFileURL
        }
        return home.appendingPathComponent("Library/Application Support/Chumi", isDirectory: true)
    }

    static func recordedPort(in directory: URL, processExists: (Int32) -> Bool = { kill($0, 0) == 0 || errno == EPERM }) -> Int? {
        struct ServerInfo: Decodable { let url: String; let pid: Int32 }
        guard let data = try? Data(contentsOf: directory.appendingPathComponent("server.json")),
              let info = try? JSONDecoder().decode(ServerInfo.self, from: data), info.pid > 0,
              let url = URLComponents(string: info.url), url.scheme == "http",
              ["127.0.0.1", "localhost"].contains(url.host ?? ""),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/", let port = url.port, (1...65535).contains(port),
              processExists(info.pid) else { return nil }
        return port
    }

    static func existingPort(in directory: URL, fallback: Int = defaultPort,
                             probe: (Int) -> Bool = { isChumi(health(port: $0, timeout: 1.5)) }) -> Int? {
        var candidates = [Int]()
        if let recorded = recordedPort(in: directory) { candidates.append(recorded) }
        if !candidates.contains(fallback) { candidates.append(fallback) }
        for port in candidates {
            // A busy or still-starting server may miss the first health request.
            if probe(port) || probe(port) { return port }
        }
        return nil
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
        // Match Node/libuv: TIME_WAIT connections do not prevent a new listener.
        let s = socket(AF_INET, SOCK_STREAM, 0)
        guard s >= 0 else { return true }
        defer { close(s) }
        var reuse: Int32 = 1
        guard setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size)) == 0 else { return true }
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        } == 0
        return !bound
    }

    // MARK: - Start / stop

    /// Connects to the recorded server (then 4777), or starts one. Completion is called on the main queue.
    func start(completion: @escaping @Sendable (ServerStartResult) -> Void) {
        start(restarting: false, completion: completion)
    }

    private func start(restarting: Bool, completion: @escaping @Sendable (ServerStartResult) -> Void) {
        lock.lock()
        let accepted = lifecycle.beginStart()
        lock.unlock()
        guard accepted else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            if restarting { self.stop() }
            let result = self.startBlocking()
            if case .failed = result { self.stop() }
            DispatchQueue.main.async {
                self.lock.lock()
                self.lifecycle.finishStart()
                self.lock.unlock()
                completion(result)
                // An exit between health and delivery still belongs to this start, not a second alert.
                self.lock.lock()
                let exited = self.process.map { self.lifecycle.shouldReportExit($0) && !$0.isRunning } ?? false
                let process = self.process
                self.lock.unlock()
                if exited, let process { self.reportUnexpectedExit(process) }
            }
        }
    }

    private func startBlocking() -> ServerStartResult {
        // Reuse a server that's already running (e.g. `npm run dev` in a terminal).
        let directory = Self.dataDirectory(environment: ProcessInfo.processInfo.environment,
                                           home: FileManager.default.homeDirectoryForCurrentUser, repo: repoPath)
        if let existing = Self.existingPort(in: directory) {
            port = existing
            ownsServer = false
            appendLog("=== \(Date()) Chumi.app connected to an already-running server on port \(port)\n")
            return .ready(baseURL, owned: false)
        }

        let repo = repoPath
        let mainTS = (repo as NSString).appendingPathComponent("server/main.ts")
        guard FileManager.default.fileExists(atPath: mainTS) else {
            return .failed(L("The Chumi server was not found at:\n{path}\n\nRebuild the app with native/build.sh from the repository, or set ChumiRepoPath in Chumi.app/Contents/Info.plist.", ["path": mainTS]))
        }
        // If the repo is in a privacy-protected folder (~/Documents, ~/Desktop, iCloud Drive), macOS asks
        // once whether Chumi may access it. Trigger that here (off the main thread) so node does not stall
        // on it during the health-check window.
        let slowNotice = DispatchWorkItem { [weak self] in
            self?.onStatus?(L("Waiting for permission to access {path}…\nIf macOS asks whether Chumi may access this folder, choose Allow.", ["path": (repo as NSString).abbreviatingWithTildeInPath]))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: slowNotice)
        let readable = FileHandle(forReadingAtPath: mainTS).map { h -> Bool in
            defer { try? h.close() }
            return (try? h.read(upToCount: 1)) != nil
        } ?? false
        slowNotice.cancel()
        DispatchQueue.main.async { [weak self] in self?.onStatus?(L("Starting Chumi…")) }
        guard readable else {
            return .failed(L("Chumi cannot read its server files in:\n{path}\n\nAllow access in System Settings → Privacy & Security → Files and Folders → Chumi, then reopen Chumi.", ["path": repo]))
        }

        guard let node = ServerManager.findNode() else {
            return .failed(L("Chumi needs Node.js {version} or later and did not find it (looked in the recorded build path, Homebrew, your login shell PATH and common version-manager locations; older versions are skipped).\n\nInstall a current Node.js (e.g. `brew install node`) and reopen Chumi.", ["version": String(ServerManager.minimumNodeMajor)]))
        }
        guard let chosen = (ServerManager.defaultPort...ServerManager.lastPort).first(where: { !ServerManager.portBusy($0) }) else {
            return .failed(L("No free port between {first} and {last} on 127.0.0.1.", ["first": String(ServerManager.defaultPort), "last": String(ServerManager.lastPort)]))
        }
        port = chosen

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [mainTS]
        p.currentDirectoryURL = URL(fileURLWithPath: repo)
        var env = ProcessInfo.processInfo.environment
        env["CHUMI_APP"] = "1"
        env["CHUMI_SYSTEM_LANGUAGE"] = ShellLocalization.systemLanguage
        env["CHUMI_SHUTDOWN_GRACE_MS"] = String(ServerManager.shutdownGraceMilliseconds)
        env["CHUMI_AUDIO_HELPER"] = helperPath
        env["PORT"] = String(chosen)
        env["PATH"] = ServerManager.serverPath(node: node, inherited: env["PATH"])
        p.environment = env

        let fd = open(logURL.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        guard fd >= 0 else { return .failed(L("Could not open the log file {path}.", ["path": logURL.path])) }
        let logHandle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        let logStart = (try? logHandle.seekToEnd()) ?? 0
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
            let unexpected = !intentional && self.lifecycle.shouldReportExit(proc)
            self.lock.unlock()
            let status = proc.terminationStatus
            self.appendLog("=== \(Date()) server exited with status \(status)\(intentional ? " (requested)" : "")\n")
            if unexpected { DispatchQueue.main.async { self.reportUnexpectedExit(proc) } }
        }

        lock.lock()
        process = p
        stdinPipe = input
        ownsServer = true
        intentionalStop = false
        lock.unlock()
        do {
            try p.run()
        } catch {
            return .failed(L("Could not start node: {error}", ["error": error.localizedDescription]))
        }
        // Wait for health (every 250 ms, up to 30 s).
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            if !p.isRunning {
                return .failed(Self.startupFailure(tail: logTail(since: logStart), repo: repo,
                                                  reason: L("The Chumi server exited during startup (status {status}).", ["status": String(p.terminationStatus)])))
            }
            if ServerManager.isChumi(ServerManager.health(port: chosen, timeout: 0.8)), p.isRunning {
                lock.lock()
                lifecycle.markReady(p)
                lock.unlock()
                return .ready(baseURL, owned: true)
            }
            usleep(250_000)
        }
        return .failed(Self.startupFailure(tail: logTail(since: logStart), repo: repo,
                                          reason: L("The Chumi server did not become ready within 30 seconds.")))
    }

    static func startupFailure(tail: String, repo: String, reason: String) -> String {
        let error = tail.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.last {
            $0.range(of: #"^[A-Za-z]*Error(?: \[[^\]]+\])?:"#, options: .regularExpression) != nil
        }
        // Node uses the same error code for missing packages and missing local files.
        let missingPackage = #"Cannot find (?:package|module) ['"]((?:@[A-Za-z0-9_~-][A-Za-z0-9._~-]*/)?[A-Za-z0-9_~-][A-Za-z0-9._~-]*(?:/[^'":\\\s]+)*)['"]"#
        if error?.range(of: missingPackage, options: .regularExpression) != nil {
            return L("Chumi's dependencies are missing or out of date.\n\nRun npm install in:\n{path}\n\nThen choose Try Again. Open Log for technical details.", ["path": repo])
        }
        if tail.contains("Chumi is already using this data folder") {
            return L("Another Chumi server is already using this data folder.\n\nUse that server's window, or stop it and choose Try Again. Open Log for technical details.")
        }
        if tail.contains("EADDRINUSE") {
            return L("The server port is already in use.\n\nChoose Try Again to find an available port. Open Log for technical details.")
        }
        let detail = [reason, error].compactMap { $0 }.joined(separator: "\n\n")
        return L("{reason}\n\nChoose Open Log for technical details, then Try Again.", ["reason": detail])
    }

    /// Only an owned server will stop on quit. An unanswered check must not imply that its work is saved.
    func quitCheck() -> QuitCheck {
        lock.lock()
        let state = lifecycle
        let current = ownsServer && process?.isRunning == true ? process : nil
        let port = self.port
        lock.unlock()
        // A child that has not passed health yet cannot have meeting work to lose.
        return state.quitCheck(for: current) { ServerManager.get(port: port, path: "/api/quit-check", timeout: 2) }
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
        lifecycle.stop()
        lock.unlock()
        guard owned, let p else { return }
        if !ServerManager.stopOwnedProcess(p) {
            appendLog("=== \(Date()) server exceeded its shutdown budget; forced termination\n")
        }
        try? input?.fileHandleForWriting.close()
    }

    func restart(completion: @escaping @Sendable (ServerStartResult) -> Void) {
        start(restarting: true, completion: completion)
    }

    private func reportUnexpectedExit(_ process: Process) {
        lock.lock()
        let report = !intentionalStop && process === self.process && lifecycle.shouldReportExit(process)
        if report { lifecycle.stop() }
        lock.unlock()
        guard report else { return }
        onUnexpectedExit?(process.terminationStatus, logTail())
    }

    // MARK: - Log helpers

    func appendLog(_ text: String) {
        let fd = open(logURL.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        guard fd >= 0 else { return }
        defer { close(fd) }
        let bytes = Array(text.utf8)
        _ = bytes.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
    }

    func logTail(lines: Int = 25, since offset: UInt64 = 0) -> String {
        guard let handle = try? FileHandle(forReadingFrom: logURL) else { return L("(log unavailable)") }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let start = max(min(offset, size), size > 16384 ? size - 16384 : 0)
        try? handle.seek(toOffset: start)
        let data = (try? handle.readToEnd()) ?? Data()
        let text = String(decoding: data, as: UTF8.self)
        return text.split(separator: "\n", omittingEmptySubsequences: false).suffix(lines).joined(separator: "\n")
    }
}
