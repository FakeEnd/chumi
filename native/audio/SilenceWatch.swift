// SilenceWatch.swift — warns once when a source delivers (digital) silence for too long; re-arms
// when signal returns. Driven from the source's pipeline queue.

import Foundation
import CoreAudio
import IOKit

final class SilenceWatch {
    private let pipeline: SourcePipeline
    private let threshold: Float
    private let seconds: Double
    private let code: String
    private let message: () -> String
    private var lastSignal: Double = 0
    private var warned = false
    private var timer: DispatchSourceTimer?

    /// `threshold`: a block counts as silent if max |sample| <= threshold.
    init(pipeline: SourcePipeline, threshold: Float, seconds: Double, code: String, message: @escaping () -> String) {
        self.pipeline = pipeline
        self.threshold = threshold
        self.seconds = seconds
        self.code = code
        self.message = message
    }

    func start() {
        let q = pipeline.queue
        q.async {
            self.lastSignal = Clock.now()
            self.pipeline.onInputBlock = { [weak self] maxAbs, _ in
                guard let self else { return }
                if maxAbs > self.threshold {
                    self.lastSignal = Clock.now()
                    if self.warned {
                        self.warned = false
                        EventLog.emit(["type": "info", "code": .string(self.code + "_cleared"),
                                       "source": .string(self.pipeline.source.name), "message": "Audio signal detected again."])
                    }
                }
            }
        }
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(deadline: .now() + 1, repeating: 1)
        t.setEventHandler { [weak self] in
            guard let self, !self.warned else { return }
            if Clock.now() - self.lastSignal >= self.seconds {
                self.warned = true
                EventLog.warning(self.code, self.message())
            }
        }
        t.resume()
        timer = t
    }

    /// Restart the silence clock (e.g. after a device change).
    func rearm() {
        pipeline.queue.async {
            self.lastSignal = Clock.now()
            self.warned = false
        }
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
