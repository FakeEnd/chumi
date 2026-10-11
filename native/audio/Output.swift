// Output.swift — stdout binary frame writer, stderr NDJSON event log, monotonic clock.
//
// Everything that touches fd 1 / fd 2 lives here. stdout carries ONLY "CHA1" frames;
// stderr carries ONLY one JSON object per line.

import Foundation
import Darwin

// MARK: - Minimal ordered JSON encoding

enum JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral,
    ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral, ExpressibleByNilLiteral
{
    case string(String)
    case number(Double)
    case int(Int)
    case bool(Bool)
    case array([JSONValue])
    case object([(String, JSONValue)])
    case null

    init(stringLiteral value: String) { self = .string(value) }
    init(integerLiteral value: Int) { self = .int(value) }
    init(floatLiteral value: Double) { self = .number(value) }
    init(booleanLiteral value: Bool) { self = .bool(value) }
    init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    init(nilLiteral: ()) { self = .null }

    static func str(_ s: String?) -> JSONValue { s.map { .string($0) } ?? .null }

    var encoded: String {
        switch self {
        case .string(let s): return JSONValue.quote(s)
        case .int(let i): return String(i)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "null"
        case .number(let d):
            guard d.isFinite else { return "null" }
            if d == d.rounded() && abs(d) < 1e15 { return String(Int64(d)) }
            return String(format: "%.6g", d)
        case .array(let a): return "[" + a.map { $0.encoded }.joined(separator: ",") + "]"
        case .object(let pairs):
            return "{" + pairs.map { JSONValue.quote($0.0) + ":" + $0.1.encoded }.joined(separator: ",") + "}"
        }
    }

    static func quote(_ s: String) -> String {
        var out = "\""
        out.reserveCapacity(s.utf8.count + 2)
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if u.value < 0x20 {
                    out += String(format: "\\u%04x", u.value)
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        out += "\""
        return out
    }
}

/// Round to one decimal for level / dB reporting.
@inline(__always) func round1(_ x: Double) -> Double { (x * 10).rounded() / 10 }

// MARK: - Low level fd writing

/// Writes all bytes to `fd`. Returns 0 on success or the errno that stopped it.
/// Handles EINTR, partial writes and (defensively) non-blocking descriptors.
func writeAll(_ fd: Int32, _ base: UnsafeRawPointer, _ count: Int) -> Int32 {
    var offset = 0
    while offset < count {
        let n = Darwin.write(fd, base + offset, count - offset)
        if n > 0 {
            offset += n
            continue
        }
        if n < 0 {
            let e = errno
            if e == EINTR { continue }
            if e == EAGAIN {
                var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                _ = poll(&pfd, 1, 1000)
                continue
            }
            return e
        }
        // n == 0: should not happen for pipes; treat as closed.
        return EPIPE
    }
    return 0
}

func writeAllData(_ fd: Int32, _ data: Data) -> Int32 {
    data.withUnsafeBytes { raw -> Int32 in
        guard let base = raw.baseAddress else { return 0 }
        return writeAll(fd, base, raw.count)
    }
}

/// Make sure our end of a pipe/socket is blocking (some parents hand out O_NONBLOCK descriptors).
func makeBlocking(_ fd: Int32) {
    let flags = fcntl(fd, F_GETFL)
    if flags >= 0 && (flags & O_NONBLOCK) != 0 {
        _ = fcntl(fd, F_SETFL, flags & ~O_NONBLOCK)
    }
}

// MARK: - stderr events

enum EventLog {
    static let queue = DispatchQueue(label: "local.chumi.audio.events", qos: .utility)
    nonisolated(unsafe) static var broken = false

    static func emit(_ obj: KeyValuePairs<String, JSONValue>) {
        emit(obj.map { ($0.key, $0.value) })
    }

    static func emit(_ pairs: [(String, JSONValue)]) {
        let line = JSONValue.object(pairs).encoded + "\n"
        queue.async {
            guard !broken else { return }
            var bytes = Array(line.utf8)
            let rc = bytes.withUnsafeMutableBytes { writeAll(2, $0.baseAddress!, $0.count) }
            if rc != 0 { broken = true }
        }
    }

    static func warning(_ code: String, _ message: String) {
        emit(["type": "warning", "code": .string(code), "message": .string(message)])
    }

    static func error(_ code: String, _ message: String) {
        emit(["type": "error", "code": .string(code), "message": .string(message)])
    }

    static func debug(_ message: String) {
        guard Options.debug else { return }
        emit(["type": "debug", "message": .string(message)])
    }

    /// Block until every queued line has been written.
    static func flush() { queue.sync {} }
}

// MARK: - stdout frames

enum SourceID: UInt8 {
    case mic = 1
    case system = 2
    var name: String { self == .mic ? "mic" : "system" }
}

enum FrameWriter {
    static let queue = DispatchQueue(label: "local.chumi.audio.stdout", qos: .userInitiated)
    private static let lock = NSLock()
    nonisolated(unsafe) private static var pendingBytes = 0
    nonisolated(unsafe) private static var dropping = false
    nonisolated(unsafe) static var broken = false
    /// Called (once, on the main queue) when stdout is gone.
    nonisolated(unsafe) static var onBrokenPipe: (() -> Void)?

    /// Max bytes queued but not yet written (~4 min of one source at 16 kHz). Beyond this frames are
    /// dropped instead of growing memory without bound while the parent is not reading.
    static let maxPendingBytes = 8 * 1024 * 1024

    static func write(source: SourceID, timestamp: Double, samples: [Int16]) {
        guard !samples.isEmpty else { return }
        let n = samples.count
        var data = Data(count: 20 + n * 2)
        data.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
            let p = raw.baseAddress!
            p.storeBytes(of: 0x43, toByteOffset: 0, as: UInt8.self)  // C
            p.storeBytes(of: 0x48, toByteOffset: 1, as: UInt8.self)  // H
            p.storeBytes(of: 0x41, toByteOffset: 2, as: UInt8.self)  // A
            p.storeBytes(of: 0x31, toByteOffset: 3, as: UInt8.self)  // 1
            p.storeBytes(of: source.rawValue, toByteOffset: 4, as: UInt8.self)
            p.storeBytes(of: 0, toByteOffset: 5, as: UInt8.self)
            p.storeBytes(of: UInt16(0).littleEndian, toByteOffset: 6, as: UInt16.self)
            p.storeBytes(of: timestamp.bitPattern.littleEndian, toByteOffset: 8, as: UInt64.self)
            p.storeBytes(of: UInt32(n).littleEndian, toByteOffset: 16, as: UInt32.self)
            samples.withUnsafeBufferPointer { src in
                let dst = (p + 20).assumingMemoryBound(to: Int16.self)
                for i in 0..<n { dst[i] = src[i].littleEndian }
            }
        }

        lock.lock()
        if broken {
            lock.unlock()
            return
        }
        if pendingBytes + data.count > maxPendingBytes {
            let first = !dropping
            dropping = true
            lock.unlock()
            if first {
                EventLog.warning("stdout_backpressure", "The reader is not consuming audio frames fast enough; dropping frames.")
            }
            return
        }
        dropping = false
        pendingBytes += data.count
        lock.unlock()

        queue.async {
            let rc = writeAllData(1, data)
            lock.lock()
            pendingBytes -= data.count
            let wasBroken = broken
            if rc != 0 { broken = true }
            lock.unlock()
            if rc != 0 && !wasBroken {
                DispatchQueue.main.async { onBrokenPipe?() }
            }
        }
    }

    static func flush() { queue.sync {} }
}

// MARK: - Monotonic clock (host time relative to helper start)

enum Clock {
    nonisolated(unsafe) static var startHost: UInt64 = 0
    nonisolated(unsafe) static var ticksToSeconds: Double = 1e-9

    static func start() {
        var tb = mach_timebase_info_data_t()
        mach_timebase_info(&tb)
        ticksToSeconds = Double(tb.numer) / Double(tb.denom) / 1e9
        startHost = mach_absolute_time()
    }

    /// Seconds since helper start for a mach host time.
    @inline(__always) static func seconds(hostTime: UInt64) -> Double {
        Double(Int64(bitPattern: hostTime &- startHost)) * ticksToSeconds
    }

    @inline(__always) static func now() -> Double { seconds(hostTime: mach_absolute_time()) }
}
