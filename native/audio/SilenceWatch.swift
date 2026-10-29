// SilenceWatch.swift — warns once when a source delivers (digital) silence for too long; re-arms
// when signal returns. Driven from the source's pipeline queue.

import Foundation
import CoreAudio
import IOKit

// The dispatch timer pauses during sleep. Compare both clocks before counting silence after wake.
struct SilenceState {
    private var lastSignal: Double
    private var sleepOffset: Double
    private(set) var warned = false

    init(now: Double, awakeTime: Double) {
        lastSignal = now
        sleepOffset = now - awakeTime
    }

    mutating func signal(now: Double) -> Bool {
        lastSignal = now
        let cleared = warned
        warned = false
        return cleared
    }

    /// true warns, false clears an old warning, nil leaves the notice alone.
    mutating func check(now: Double, awakeTime: Double, seconds: Double) -> Bool? {
        if now - awakeTime - sleepOffset > 1 {
            sleepOffset = now - awakeTime
            return signal(now: now) ? false : nil
        }
        if !warned && now - lastSignal >= seconds {
            warned = true
            return true
        }
        return nil
    }
}

final class SilenceWatch {
    private let pipeline: SourcePipeline
    private let threshold: Float
    private let seconds: Double
    private let code: String
    private let message: () -> String
    private let vars: () -> [(String, JSONValue)]
    private var state = SilenceState(now: Clock.now(), awakeTime: Clock.awakeTime())
    private var timer: DispatchSourceTimer?

    /// `threshold`: a block counts as silent if max |sample| <= threshold.
    init(pipeline: SourcePipeline, threshold: Float, seconds: Double, code: String, vars: @escaping () -> [(String, JSONValue)] = { [] }, message: @escaping () -> String) {
        self.pipeline = pipeline
        self.threshold = threshold
        self.seconds = seconds
        self.code = code
        self.message = message
        self.vars = vars
    }

    func start() {
        let q = pipeline.queue
        q.async {
            self.state = SilenceState(now: Clock.now(), awakeTime: Clock.awakeTime())
            self.pipeline.onInputBlock = { [weak self] maxAbs, _ in
                guard let self else { return }
                if maxAbs > self.threshold && self.state.signal(now: Clock.now()) { self.clearNotice() }
            }
        }
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(deadline: .now() + 1, repeating: 1)
        t.setEventHandler { [weak self] in
            guard let self, let warning = self.state.check(now: Clock.now(), awakeTime: Clock.awakeTime(), seconds: self.seconds) else { return }
            if warning {
                EventLog.emit(["type": "warning", "code": .string(self.code), "message": .string(self.message()), "vars": .object(self.vars())])
            } else { self.clearNotice() }
        }
        t.resume()
        timer = t
    }

    /// Restart the silence clock (e.g. after a device change).
    func rearm() {
        pipeline.queue.async {
            if self.state.warned { self.clearNotice() }
            self.state = SilenceState(now: Clock.now(), awakeTime: Clock.awakeTime())
        }
    }

    private func clearNotice() {
        EventLog.emit(["type": "info", "code": .string(code + "_cleared"),
                       "source": .string(pipeline.source.name), "message": "Audio signal detected again."])
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }
}

enum Hardware {
    /// true if a MacBook lid is closed (clamshell mode), nil if unknown / not a laptop.
    static func lidClosed() -> Bool? {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }
        guard let prop = IORegistryEntryCreateCFProperty(service, "AppleClamshellState" as CFString, kCFAllocatorDefault, 0)?
            .takeRetainedValue() else { return nil }
        return prop as? Bool
    }

    static func isBuiltIn(_ device: AudioObjectID) -> Bool {
        CA.get(device, kAudioDevicePropertyTransportType, initial: UInt32(0)) == kAudioDeviceTransportTypeBuiltIn
    }
}
