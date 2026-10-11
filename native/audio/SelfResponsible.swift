// SelfResponsible.swift — `--self-responsible`: re-exec ourselves with the responsibility "disclaim"
// spawn attribute so macOS privacy (TCC) prompts and grants are attributed to this helper binary
// (bundle id local.chumi.audio from the embedded Info.plist) instead of the parent terminal / app.

import Foundation
import Darwin

enum SelfResponsible {
    static let childMarker = "CHUMI_AUDIO_RESPONSIBLE_CHILD"

    static var isChild: Bool { getenv(childMarker) != nil }

    static func executablePath() -> String {
        var size: UInt32 = 0
        _ = _NSGetExecutablePath(nil, &size)
        var buf = [CChar](repeating: 0, count: Int(size) + 1)
        guard _NSGetExecutablePath(&buf, &size) == 0 else { return CommandLine.arguments[0] }
        let raw = String(cString: buf)
        if let resolved = realpath(raw, nil) {
            defer { free(resolved) }
            return String(cString: resolved)
        }
        return raw
    }

    /// Spawns the child and never returns if that worked (exits with the child's status).
    /// Returns normally if spawning failed, so the caller can continue in-process.
    static func relaunch() {
        typealias DisclaimFn = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32

        var attr: posix_spawnattr_t? = nil
        guard posix_spawnattr_init(&attr) == 0 else { return }
        defer { posix_spawnattr_destroy(&attr) }

        var disclaimed = false
        if let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") {  // RTLD_DEFAULT
            let fn = unsafeBitCast(sym, to: DisclaimFn.self)
            disclaimed = fn(&attr, 1) == 0
        }

        // Child starts with default dispositions for the signals we touch and an empty mask.
        var defaults = sigset_t()
        sigemptyset(&defaults)
        for s in [SIGTERM, SIGINT, SIGHUP, SIGPIPE] { sigaddset(&defaults, s) }
        posix_spawnattr_setsigdefault(&attr, &defaults)
        var mask = sigset_t()
        sigemptyset(&mask)
        posix_spawnattr_setsigmask(&attr, &mask)
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))

        // A self-responsible process is its own privacy identity: if the binary lives in a protected
        // folder, launching it triggers (and blocks on) a "files in your Documents folder" prompt.
        let pathForCheck = executablePath()
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        for folder in ["Documents", "Desktop", "Downloads", "Library/Mobile Documents"] where pathForCheck.hasPrefix(home + "/" + folder + "/") {
            EventLog.warning("self_responsible_protected_location", "The helper is in ~/\(folder), a privacy-protected folder. As a self-responsible process macOS may first ask to allow \"chumi-audio\" to access files in that folder, and the helper waits until the prompt is answered. Prefer running capture through Chumi.app, or place the helper outside protected folders.")
        }

        var env = ProcessInfo.processInfo.environment
        env[childMarker] = "1"
        let envStrings = env.map { "\($0.key)=\($0.value)" }
        let path = executablePath()
        let args = [path] + Array(CommandLine.arguments.dropFirst())

        var cArgs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) } + [nil]
        var cEnv: [UnsafeMutablePointer<CChar>?] = envStrings.map { strdup($0) } + [nil]
        defer {
            cArgs.forEach { free($0) }
            cEnv.forEach { free($0) }
        }

        // stdin/stdout/stderr are inherited as-is (no file actions).
        var pid: pid_t = 0
        let rc = posix_spawn(&pid, path, nil, &attr, &cArgs, &cEnv)
        guard rc == 0 else {
            EventLog.warning("self_responsible_failed", "Could not re-launch as a self-responsible process (errno \(rc)); continuing in-process.")
            EventLog.flush()
            return
        }
        if !disclaimed {
            EventLog.debug("responsibility_spawnattrs_setdisclaim unavailable; child launched without disclaim")
        }

        // Forward termination signals to the child.
        var sources: [DispatchSourceSignal] = []
        for s in [SIGTERM, SIGINT, SIGHUP] {
            signal(s, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: s, queue: .main)
            src.setEventHandler { kill(pid, s) }
            src.resume()
            sources.append(src)
        }
        signal(SIGPIPE, SIG_IGN)

        let waiter = Thread {
            var status: Int32 = 0
            while waitpid(pid, &status, 0) == -1 {
                if errno != EINTR { exit(1) }
            }
            let low = status & 0x7f
            if low == 0 {
                exit((status >> 8) & 0xff)
            }
            // Child died from a signal: die the same way.
            signal(low, SIG_DFL)
            var unblock = sigset_t()
            sigemptyset(&unblock)
            sigaddset(&unblock, low)
            sigprocmask(SIG_UNBLOCK, &unblock, nil)
            kill(getpid(), low)
            exit(128 + low)
        }
        waiter.start()
        withExtendedLifetime(sources) {
            dispatchMain()
        }
    }
}
