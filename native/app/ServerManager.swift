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

    static func findNode() -> String? {
        let fm = FileManager.default
        for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] where fm.isExecutableFile(atPath: candidate) {
            return candidate
        }
        // Ask a login shell (picks up nvm/fnm/asdf PATH setup in ~/.zprofile / ~/.zshrc).
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "command -v node"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(8)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning { p.terminate(); return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        let path = String(decoding: data, as: UTF8.self)
            .split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .last { $0.hasPrefix("/") } ?? ""
        return fm.isExecutableFile(atPath: path) ? path : nil
    }

    // MARK: - Health / ports

    /// GET /api/health with a short timeout. Returns (HTTP status, parsed JSON object) or nil.
    static func health(port: Int, timeout: TimeInterval = 1.0) -> (Int, [String: Any]?)? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/health") else { return nil }
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
            return .failed("Node.js was not found (looked in /opt/homebrew/bin, /usr/local/bin and your login shell PATH).\n\nInstall Node.js (e.g. `brew install node`) and reopen Chumi.")
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
        env["CHUMI_AUDIO_HELPER"] = helperPath
        env["PORT"] = String(chosen)
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
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
            self.lock.lock()
            let intentional = self.intentionalStop
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

    /// SIGTERM the server we started, wait up to 3 s, then SIGKILL.
    func stop() {
        lock.lock()
        let p = process
        intentionalStop = true
        lock.unlock()
        guard ownsServer, let p, p.isRunning else { return }
        let pid = p.processIdentifier
        kill(pid, SIGTERM)
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning {
            kill(pid, SIGKILL)
            usleep(100_000)
        }
        try? stdinPipe?.fileHandleForWriting.close()
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
