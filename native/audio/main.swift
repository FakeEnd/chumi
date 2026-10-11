// chumi-audio — microphone + computer-audio capture helper for Chumi.
// Streams 16 kHz mono Int16 "CHA1" frames on stdout and NDJSON events on stderr. See native/README.md.

import Foundation
import AVFoundation
import CoreAudio
import Darwin

Clock.start()
signal(SIGPIPE, SIG_IGN)

// MARK: - Options

enum Mode { case stream, listDevices, checkPermissions, requestMic, help, version }

enum Options {
    nonisolated(unsafe) static var mode: Mode = .stream
    nonisolated(unsafe) static var source = "mic"
    nonisolated(unsafe) static var micDevice: String?
    nonisolated(unsafe) static var aec: Bool?
    nonisolated(unsafe) static var chunkMs = 50
    nonisolated(unsafe) static var ignoreStdin = false
    nonisolated(unsafe) static var selfResponsible = false
    nonisolated(unsafe) static var debug = ProcessInfo.processInfo.environment["CHUMI_AUDIO_DEBUG"] == "1"

    static let usage = """
    chumi-audio — Chumi audio capture helper

    Streaming:
      chumi-audio --source mic|system|both [--mic-device <CoreAudio UID>] [--aec on|off] [--chunk-ms 50]
                  [--self-responsible] [--ignore-stdin] [--debug]
    Queries (print JSON to stdout and exit):
      chumi-audio --list-devices
      chumi-audio --check-permissions
      chumi-audio --request-mic

    stdout: binary frames  "CHA1" | u8 source (1 mic, 2 system) | u8 flags | u16 0 | f64 ts | u32 N | N x i16 @16 kHz
    stderr: one JSON event per line (ready, level, permission, warning, error, device_changed, stopped)
    The helper exits when stdin reaches EOF (unless --ignore-stdin), on SIGTERM/SIGINT, or when stdout closes.
    """

    static func fail(_ message: String) -> Never {
        EventLog.error("bad_arguments", message + " (see --help)")
        EventLog.flush()
        exit(2)
    }

    static func parse(_ argv: [String]) {
        var i = 1
        func value(_ flag: String) -> String {
            i += 1
            guard i < argv.count else { fail("Missing value for \(flag)") }
            return argv[i]
        }
        while i < argv.count {
            let arg = argv[i]
            switch arg {
            case "--source":
                let v = value(arg)
                guard ["mic", "system", "both"].contains(v) else { fail("--source must be mic, system or both") }
                source = v
            case "--mic-device": micDevice = value(arg)
            case "--aec":
                switch value(arg) {
                case "on", "true", "1": aec = true
                case "off", "false", "0": aec = false
                default: fail("--aec must be on or off")
                }
            case "--chunk-ms":
                guard let v = Int(value(arg)), v >= 10, v <= 1000 else { fail("--chunk-ms must be an integer between 10 and 1000") }
                chunkMs = v
            case "--list-devices": mode = .listDevices
            case "--check-permissions": mode = .checkPermissions
            case "--request-mic": mode = .requestMic
            case "--self-responsible": selfResponsible = true
            case "--ignore-stdin": ignoreStdin = true
            case "--debug": debug = true
            case "--help", "-h": mode = .help
            case "--version": mode = .version
            default: fail("Unknown argument \(arg)")
            }
            i += 1
        }
    }
}

// MARK: - Device listing

func listDevicesJSON() -> String {
    let defaultInput = CA.defaultInputDevice()
    var items: [JSONValue] = []
    for dev in CA.allDevices() {
        let channels = CA.channelCount(dev, scope: kAudioObjectPropertyScopeInput)
        guard channels > 0, let uid = CA.uid(dev) else { continue }
        // Skip hidden/private aggregate devices created by other apps' capture sessions.
        if uid.hasPrefix("local.chumi.audio.aggregate.") { continue }
        items.append(.object([
            ("uid", .string(uid)),
            ("name", .string(CA.name(dev) ?? uid)),
            ("isDefault", .bool(dev == defaultInput)),
            ("inputChannels", .int(channels)),
        ]))
    }
    return JSONValue.array(items).encoded
}

// MARK: - Streaming controller

final class Controller {
    private var mic: MicCapture?
    private var system: SystemCapture?
    private var pendingStarts = 0
    private var micOK = false
    private var systemOK = false
    private var readyEmitted = false
    private var graceExpired = false
    private var pendingNames: [String] = []
    /// After this long, emit "ready" for the sources already running even if another source is still
    /// waiting (typically on a macOS permission prompt); it reports "source_started" when it comes up.
    static let readyGraceSeconds: Double = 5
    private var stopping = false
    private var signalSources: [DispatchSourceSignal] = []
    private let signalQueue = DispatchQueue(label: "local.chumi.audio.signals")
    private let shutdownLock = NSLock()
    private var shutdownRequested = false

    func start() {
        installSignalHandlers()
        if !Options.ignoreStdin { watchStdin() }
        FrameWriter.onBrokenPipe = { [weak self] in self?.requestShutdown(reason: "stdout_closed", code: 0) }

        let wantMic = Options.source == "mic" || Options.source == "both"
        let wantSystem = Options.source == "system" || Options.source == "both"
        let aec = wantMic && (Options.aec ?? (Options.source == "both"))

        // Start the microphone first: while macOS shows the System Audio Recording prompt, coreaudiod can
        // hold up other IO requests from this process, so get the mic running before creating the tap.
        var systemStarted = false
        let startSystem: () -> Void = { [weak self] in
            guard let self, wantSystem, !systemStarted, !self.stopping else { return }
            systemStarted = true
            let s = SystemCapture(pipeline: SourcePipeline(source: .system, chunkMs: Options.chunkMs))
            self.system = s
            s.start { [weak self] ok in
                guard let self else { return }
                self.systemOK = ok
                self.pendingStarts -= 1
                self.pendingNames.removeAll { $0 == "system" }
                self.sourceResolved("system", ok: ok)
            }
        }
        if wantSystem {
            pendingStarts += 1
            pendingNames.append("system")
        }
        if wantMic {
            let m = MicCapture(pipeline: SourcePipeline(source: .mic, chunkMs: Options.chunkMs),
                               requestedUID: Options.micDevice, aec: aec)
            mic = m
            pendingStarts += 1
            pendingNames.append("mic")
            m.start { [weak self] ok in
                guard let self else { return }
                self.micOK = ok
                self.pendingStarts -= 1
                self.pendingNames.removeAll { $0 == "mic" }
                self.sourceResolved("mic", ok: ok)
                startSystem()
            }
            // Don't hold system audio back for long if the mic is waiting on its own permission prompt.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { startSystem() }
        } else {
            startSystem()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Controller.readyGraceSeconds) { [weak self] in
            guard let self else { return }
            self.graceExpired = true
            self.checkReady()
        }
        checkReady()
    }

    private func sourceResolved(_ name: String, ok: Bool) {
        if readyEmitted {
            if ok {
                EventLog.emit(["type": "source_started", "source": .string(name)])
            } else if !micOK && !systemOK && pendingStarts == 0 {
                requestShutdown(reason: "error", code: 1)
            }
            return
        }
        checkReady()
    }

    private func checkReady() {
        guard !readyEmitted, !stopping else { return }
        if pendingStarts > 0 {
            // Still waiting on a source: only report early if something is already running.
            guard graceExpired, micOK || systemOK else { return }
        }
        readyEmitted = true
        var sources: [JSONValue] = []
        if micOK { sources.append("mic") }
        if systemOK { sources.append("system") }
        if sources.isEmpty {
            requestShutdown(reason: "error", code: 1)
            return
        }
        var pairs: [(String, JSONValue)] = [("type", "ready"), ("sources", .array(sources))]
        if micOK, let m = mic {
            pairs += [("micDevice", .str(m.deviceName)), ("micUID", .str(m.deviceUID)), ("aec", .bool(m.aecActive))]
        } else {
            pairs.append(("aec", false))
        }
        if systemOK, let s = system {
            pairs.append(("systemOutputDevice", .str(s.outputName)))
        }
        if !pendingNames.isEmpty {
            pairs.append(("pending", .array(pendingNames.map { .string($0) })))
        }
        pairs += [("sampleRate", 16000), ("chunkMs", .int(Options.chunkMs)), ("pid", .int(Int(getpid())))]
        EventLog.emit(pairs)
    }

    /// Thread-safe. Starts an orderly shutdown on the main queue, with a watchdog that hard-exits if the
    /// main thread is stuck (e.g. inside a Core Audio call waiting on a permission prompt). Private
    /// taps and aggregate devices are destroyed by coreaudiod when the process exits in any case.
    func requestShutdown(reason: String, code: Int32) {
        shutdownLock.lock()
        if shutdownRequested {
            shutdownLock.unlock()
            return
        }
        shutdownRequested = true
        shutdownLock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + 4) {
            let line = Array("{\"type\":\"stopped\",\"reason\":\"\(reason)\",\"forced\":true}\n".utf8)
            _ = line.withUnsafeBytes { writeAll(2, $0.baseAddress!, $0.count) }
            _exit(code)
        }
        DispatchQueue.main.async { self.shutdown(reason: reason, code: code) }
    }

    private func shutdown(reason: String, code: Int32) {
        guard !stopping else { return }
        stopping = true
        // Stop both sources concurrently with one shared deadline (Node SIGKILLs after 3 s).
        let deadline = DispatchTime.now() + 1.5
        let group = DispatchGroup()
        if let mic {
            group.enter()
            DispatchQueue.global().async { mic.stop(deadline: deadline); group.leave() }
        }
        if let system {
            group.enter()
            DispatchQueue.global().async { system.stop(deadline: deadline); group.leave() }
        }
        _ = group.wait(timeout: deadline + 0.1)
        for p in [mic?.pipeline, system?.pipeline].compactMap({ $0 }) {
            waitOn(p.queue, seconds: 1) { p.flushPartialChunk() }
        }
        waitOn(FrameWriter.queue, seconds: 1) {}
        EventLog.emit(["type": "stopped", "reason": .string(reason)])
        waitOn(EventLog.queue, seconds: 1) {}
        _exit(code)  // everything is flushed; skip atexit/static destructors while audio threads wind down
    }

    /// Run `work` on `queue` and wait for it, but never longer than `seconds` (stdout may be stuck).
    private func waitOn(_ queue: DispatchQueue, seconds: Double, _ work: @escaping () -> Void) {
        let sem = DispatchSemaphore(value: 0)
        queue.async { work(); sem.signal() }
        _ = sem.wait(timeout: .now() + seconds)
    }

    private func installSignalHandlers() {
        for s in [SIGTERM, SIGINT, SIGHUP] {
            signal(s, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: s, queue: signalQueue)
            src.setEventHandler { [weak self] in self?.requestShutdown(reason: "signal", code: 0) }
            src.resume()
            signalSources.append(src)
        }
    }

    /// Exit when stdin reaches EOF, so the helper dies with its parent.
    private func watchStdin() {
        let thread = Thread { [weak self] in
            var buf = [UInt8](repeating: 0, count: 4096)
            while true {
                let n = read(0, &buf, buf.count)
                if n > 0 { continue }
                if n < 0 {
                    let e = errno
                    if e == EINTR { continue }
                    if e == EAGAIN {
                        var pfd = pollfd(fd: 0, events: Int16(POLLIN), revents: 0)
                        _ = poll(&pfd, 1, 1000)
                        continue
                    }
                    if e == EBADF { return }  // no stdin at all: nothing to watch
                }
                break
            }
            self?.requestShutdown(reason: "stdin_closed", code: 0)
        }
        thread.name = "stdin-watch"
        thread.start()
    }
}

// MARK: - Entry

Options.parse(CommandLine.arguments)

switch Options.mode {
case .help:
    print(Options.usage)
    exit(0)
case .version:
    print("chumi-audio 0.1.0")
    exit(0)
case .listDevices:
    print(listDevicesJSON())
    exit(0)
default:
    break
}

if Options.selfResponsible && !SelfResponsible.isChild {
    SelfResponsible.relaunch()  // only returns if re-launching failed
}

switch Options.mode {
case .checkPermissions:
    print(Permissions.statusJSON())
    exit(0)
case .requestMic:
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
        AVCaptureDevice.requestAccess(for: .audio) { _ in
            DispatchQueue.main.async {
                print(Permissions.statusJSON())
                exit(0)
            }
        }
        RunLoop.main.run()
    }
    print(Permissions.statusJSON())
    exit(0)
default:
    break
}

makeBlocking(1)
makeBlocking(2)
let controller = Controller()
controller.start()
RunLoop.main.run()
