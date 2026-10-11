// Permissions.swift — microphone TCC status (public API) and a best-effort, read-only
// system-audio-capture status (private TCC SPI, only if present).

import Foundation
import AVFoundation

enum Permissions {
    static func microphoneStatusString() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "notDetermined"
        }
    }

    /// There is no public API for the "System Audio Recording" (kTCCServiceAudioCapture) status.
    /// TCCAccessPreflight is a read-only private function that never prompts; we use it only if it can
    /// be resolved at runtime, and map only the two values we are confident about. Everything else is
    /// reported as "unknown". The result applies to the *responsible* process (e.g. Chumi.app or the
    /// terminal), exactly like the real capture would.
    nonisolated(unsafe) static var lastPreflightRaw: Int?

    static func systemAudioStatus() -> (status: String, method: String) {
        typealias PreflightFn = @convention(c) (CFString, CFDictionary?) -> Int
        guard let handle = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW),
              let sym = dlsym(handle, "TCCAccessPreflight") else {
            return ("unknown", "none")
        }
        let preflight = unsafeBitCast(sym, to: PreflightFn.self)
        let result = preflight("kTCCServiceAudioCapture" as CFString, nil)
        lastPreflightRaw = result
        switch result {
        case 0: return ("granted", "tcc_preflight")
        case 1: return ("denied", "tcc_preflight")
        default: return ("unknown", "tcc_preflight")
        }
    }

    static func statusJSON(includeSystem: Bool = true) -> String {
        var pairs: [(String, JSONValue)] = [("microphone", .string(microphoneStatusString()))]
        if includeSystem {
            let sys = systemAudioStatus()
            pairs.append(("systemAudio", .string(sys.status)))
            pairs.append(("systemAudioMethod", .string(sys.method)))
            if Options.debug, let raw = lastPreflightRaw { pairs.append(("systemAudioPreflightRaw", .int(raw))) }
        }
        return JSONValue.object(pairs).encoded
    }
}
