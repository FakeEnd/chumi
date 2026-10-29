// MicCapture.swift — microphone capture with AVAudioEngine (+ optional voice-processing AEC).
//
// Public methods are called on the main queue. Engine work runs on a private serial `control` queue:
// starting audio IO can block while macOS shows a privacy prompt, and the main queue must stay free
// for signals, readiness reporting and shutdown.

import Foundation
import AVFoundation
import AudioToolbox
import CoreAudio

struct CaptureError: Error {
    let code: String
    let message: String
}

final class MicCapture {
    let pipeline: SourcePipeline
    let requestedUID: String?
    let aecRequested: Bool

    private(set) var aecActive = false
    private(set) var deviceName: String?
    private(set) var deviceUID: String?
    private(set) var running = false

    private var engine: AVAudioEngine?
    private var configObserver: NSObjectProtocol?
    private var restartWork: DispatchWorkItem?
    private var defaultInputListener: AudioObjectPropertyListenerBlock?
    private var stopped = false
    private var warnedAEC = false
    private var warnedDevice = false
    private var loggedFormat = ""
    private var silence: SilenceWatch?
    private var currentDevice = AudioObjectID(kAudioObjectUnknown)
    static let silenceSeconds: Double = 10
    private let control = DispatchQueue(label: "local.chumi.audio.mic.control", qos: .userInitiated)
    private var startedHW: (rate: Double, channels: AVAudioChannelCount, device: AudioDeviceID) = (0, 0, 0)
    private var restartTimes: [Double] = []

    init(pipeline: SourcePipeline, requestedUID: String?, aec: Bool) {
        self.pipeline = pipeline
        self.requestedUID = requestedUID
        self.aecRequested = aec
    }

    /// Message for the mic_silent warning. Real microphones never deliver exact zeros, so a long run of
    /// digital silence means the input is disabled (lid closed), muted, or blocked by privacy settings.
    private func silenceMessage() -> String {
        let dev = currentDevice
        if dev != kAudioObjectUnknown, Hardware.isBuiltIn(dev), Hardware.lidClosed() == true {
            return "The built-in microphone is delivering digital silence because the MacBook lid is closed (macOS disables the built-in mic in clamshell mode). Open the lid or connect an external microphone and select it in Chumi."
        }
        return "The microphone \"{device}\" has delivered digital silence (all zeros) for {seconds} s. Check that it is not muted (System Settings → Sound → Input) and that microphone access is allowed in System Settings → Privacy & Security → Microphone."
    }

    /// Resolves microphone permission, then starts the engine. `completion(true)` (on the main queue)
    /// once audio is flowing.
    func start(completion: @escaping (Bool) -> Void) {
        let lock = NSLock()
        var finished = false
        var waitingForUser = false
        let done: (Bool) -> Void = { ok in
            lock.lock(); finished = true; lock.unlock()
            DispatchQueue.main.async { completion(ok) }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 4) {
            lock.lock(); let report = !finished && !waitingForUser; lock.unlock()
            if report {
                EventLog.warning("mic_start_pending", "The microphone is taking a long time to start. If macOS is showing a privacy prompt (microphone or System Audio Recording), answer it to continue.")
            }
        }
        control.async { self.resolvePermission(done: done, waiting: { lock.lock(); waitingForUser = true; lock.unlock() }) }
    }

    private func resolvePermission(done: @escaping (Bool) -> Void, waiting: @escaping () -> Void) {
        let completion = done
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        switch status {
        case .authorized:
            emitPermission("granted")
            completion(startReportingErrors())
        case .notDetermined:
            emitPermission("notDetermined")
            waiting()
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                self.control.async {
                    guard !self.stopped else { completion(false); return }
                    let now = granted ? "granted" : Permissions.microphoneStatusString()
                    self.emitPermission(now == "notDetermined" ? "denied" : now)
                    if granted {
                        completion(self.startReportingErrors())
                    } else {
                        self.emitDenied()
                        completion(false)
                    }
                }
            }
        case .denied, .restricted:
            emitPermission(status == .denied ? "denied" : "restricted")
            emitDenied()
            completion(false)
        @unknown default:
            emitPermission("denied")
            emitDenied()
            completion(false)
        }
    }

    /// Stops capture, waiting until `deadline` at most for the control queue.
    func stop(deadline: DispatchTime = .now() + 1.5) {
        silence?.stop()
        let sem = DispatchSemaphore(value: 0)
        control.async {
            self.stopped = true
            self.restartWork?.cancel()
            self.restartWork = nil
            self.removeDefaultInputListener()
            self.teardownEngine()
            self.running = false
            sem.signal()
        }
        _ = sem.wait(timeout: deadline)
    }

    // MARK: - Engine

    private func emitPermission(_ status: String) {
        EventLog.emit(["type": "permission", "kind": "microphone", "status": .string(status)])
    }

    private func emitDenied() {
        EventLog.error("mic_permission_denied",
                       "Microphone access is denied. Open System Settings → Privacy & Security → Microphone and turn on access for Chumi (or the terminal app running the helper), then restart capture.")
    }

    private func startReportingErrors() -> Bool {
        do {
            try startEngine()
            installDefaultInputListener()
            let watch = SilenceWatch(pipeline: pipeline, threshold: 0, seconds: MicCapture.silenceSeconds, code: "mic_silent", vars: { [weak self] in
                [("device", .string(self?.deviceName ?? "input")), ("seconds", .int(Int(MicCapture.silenceSeconds)))]
            }) { [weak self] in
                self?.silenceMessage() ?? "The microphone is delivering digital silence."
            }
            watch.start()
            silence = watch
            return true
        } catch let e as CaptureError {
            EventLog.error(e.code, e.message)
        } catch {
            EventLog.error("mic_start_failed", "Could not start the microphone: \(error.localizedDescription)")
        }
        installDefaultInputListener()  // so plugging in a device later can recover
        return false
    }

    private func startEngine() throws {
        // Resolve which device we will use.
        var explicitDevice: AudioObjectID?
        if let uid = requestedUID, !uid.isEmpty {
            if let d = CA.device(forUID: uid), CA.channelCount(d, scope: kAudioObjectPropertyScopeInput) > 0 {
                explicitDevice = d
            } else if !warnedDevice {
                warnedDevice = true
                EventLog.warning("mic_device_not_found", "Input device with UID \"\(uid)\" was not found; using the system default input instead.")
            }
        }
        guard let device = explicitDevice ?? CA.defaultInputDevice(),
              CA.channelCount(device, scope: kAudioObjectPropertyScopeInput) > 0 else {
            throw CaptureError(code: "no_input_device",
                               message: "No microphone is available. Connect a microphone or pick an input in System Settings → Sound → Input.")
        }

        let engine = AVAudioEngine()
        let input = engine.inputNode

        aecActive = false
        if aecRequested {
            do {
                try input.setVoiceProcessingEnabled(true)
                aecActive = input.isVoiceProcessingEnabled
                if aecActive {
                    // Do not turn other audio (the lecture/meeting playing on this Mac) down.
                    input.voiceProcessingOtherAudioDuckingConfiguration =
                        AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
                }
            } catch {
                if !warnedAEC {
                    warnedAEC = true
                    EventLog.warning("aec_unavailable", "Echo cancellation could not be enabled (\(error.localizedDescription)); continuing without it. Use headphones to avoid the mic re-capturing computer audio.")
                }
            }
        }

        if let explicitDevice, let au = input.audioUnit {
            var dev = explicitDevice
            let st = AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                          &dev, UInt32(MemoryLayout<AudioDeviceID>.size))
            if st != noErr {
                EventLog.warning("mic_device_select_failed", "Could not select input device \"\(CA.name(explicitDevice) ?? "?")\" (\(fourCC(st))); using the system default input.")
            }
        }

        // After switching devices the node's output format can still describe the previous device
        // (e.g. 1 ch while the new hardware is 2 ch). Tapping with that stale format makes the engine
        // post a configuration change right after start, so derive the tap format from the hardware.
        let hw = input.inputFormat(forBus: 0)
        var format = input.outputFormat(forBus: 0)
        if hw.sampleRate > 0, hw.channelCount > 0, hw.channelCount != format.channelCount || hw.sampleRate != format.sampleRate,
           let fixed = AVAudioFormat(standardFormatWithSampleRate: hw.sampleRate, channels: hw.channelCount) {
            EventLog.debug("mic: node output format \(format) disagrees with hardware \(hw); tapping with \(fixed)")
            format = fixed
        }
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw CaptureError(code: "no_input_device",
                               message: "The selected microphone reports no usable input format. Check System Settings → Sound → Input.")
        }
        let desc = "\(Int(format.sampleRate)) Hz, \(format.channelCount) ch, VP=\(aecActive)"
        if desc != loggedFormat {
            loggedFormat = desc
            EventLog.debug("mic: input format \(desc) \(format)")
        }

        // With voice processing on macOS the node may report several channels; the processed
        // signal is in channel 0 and the rest can be silent, so take channel 0 only.
        let firstOnly = aecActive && format.channelCount > 1
        let pipeline = self.pipeline
        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(max(1024, format.sampleRate / 10)), format: format) { buffer, when in
            let mono = downmixToMono(buffer, firstChannelOnly: firstOnly)
            let rate = buffer.format.sampleRate
            let host: Double? = when.isHostTimeValid ? Clock.seconds(hostTime: when.hostTime) : nil
            pipeline.queue.async { pipeline.push(mono, rate: rate, hostSeconds: host) }
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw CaptureError(code: "mic_start_failed",
                               message: "Could not start the microphone (\(error.localizedDescription)). Check System Settings → Sound → Input and Privacy & Security → Microphone.")
        }

        self.engine = engine
        startedHW = (hw.sampleRate, hw.channelCount, currentAUDevice(input) ?? device)
        currentDevice = device
        deviceName = CA.name(device)
        deviceUID = CA.uid(device)
        running = true

        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self, weak engine] _ in
            guard let self else { return }
            if Options.debug, let engine {
                var dev = AudioDeviceID(0)
                var size = UInt32(MemoryLayout<AudioDeviceID>.size)
                if let au = engine.inputNode.audioUnit {
                    AudioUnitGetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, &size)
                }
                EventLog.debug("mic: AVAudioEngineConfigurationChange running=\(engine.isRunning) inFmt=\(engine.inputNode.inputFormat(forBus: 0)) outFmt=\(engine.inputNode.outputFormat(forBus: 0)) auDevice=\(dev) (\(CA.name(dev) ?? "?")) default=\(CA.defaultInputDevice().flatMap { CA.name($0) } ?? "?")")
            }
            self.control.async { self.configurationChanged(engine) }
        }
    }

    private func currentAUDevice(_ input: AVAudioInputNode) -> AudioDeviceID? {
        guard let au = input.audioUnit else { return nil }
        var dev = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let st = AudioUnitGetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, &size)
        return st == noErr && dev != 0 ? dev : nil
    }

    /// AVAudioEngineConfigurationChange: restart unless it is a no-op (engine still running on the same
    /// device with the same hardware format). Restarts are rate-limited to avoid feedback loops.
    private func configurationChanged(_ changed: AVAudioEngine?) {
        guard !stopped, let engine, changed === engine else { return }
        let hw = engine.inputNode.inputFormat(forBus: 0)
        if engine.isRunning, hw.sampleRate == startedHW.rate, hw.channelCount == startedHW.channels,
           currentAUDevice(engine.inputNode) == startedHW.device {
            EventLog.debug("mic: configuration change ignored (engine running, device and format unchanged)")
            return
        }
        let now = Clock.now()
        restartTimes = restartTimes.filter { now - $0 < 10 } + [now]
        if restartTimes.count > 5 {
            EventLog.debug("mic: too many configuration changes; backing off")
            restartWork?.cancel()
            let work = DispatchWorkItem { [weak self] in self?.restart(attempt: 1) }
            restartWork = work
            control.asyncAfter(deadline: .now() + 3, execute: work)
            return
        }
        scheduleRestart(attempt: 0)
    }

    private func teardownEngine() {
        if let obs = configObserver {
            NotificationCenter.default.removeObserver(obs)
            configObserver = nil
        }
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            if aecActive {
                try? engine.inputNode.setVoiceProcessingEnabled(false)
            }
        }
        engine = nil
        running = false
    }

    private func scheduleRestart(attempt: Int) {
        guard !stopped else { return }
        restartWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.restart(attempt: attempt) }
        restartWork = work
        control.asyncAfter(deadline: .now() + (attempt == 0 ? 0.3 : 1.0), execute: work)
    }

    private func restart(attempt: Int) {
        guard !stopped else { return }
        let previous = deviceName
        teardownEngine()
        let pipeline = self.pipeline
        pipeline.queue.async { pipeline.reset() }
        do {
            try startEngine()
            silence?.rearm()
            EventLog.emit(["type": "device_changed", "kind": "input", "name": .str(deviceName),
                           "uid": .str(deviceUID), "previous": .str(previous)])
        } catch {
            if attempt < 5 {
                scheduleRestart(attempt: attempt + 1)
            } else if let e = error as? CaptureError {
                EventLog.error(e.code, e.message)
            } else {
                EventLog.error("mic_start_failed", "Could not restart the microphone after a device change: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Default input device changes

    private func installDefaultInputListener() {
        guard defaultInputListener == nil else { return }
        var addr = CA.address(kAudioHardwarePropertyDefaultInputDevice)
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self, !self.stopped else { return }
            // An explicitly chosen device keeps running unless it went away (AVAudioEngine notifies us then).
            if self.running, let uid = self.requestedUID, !uid.isEmpty, CA.device(forUID: uid) != nil { return }
            self.scheduleRestart(attempt: 0)
        }
        if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, control, block) == noErr {
            defaultInputListener = block
        }
    }

    private func removeDefaultInputListener() {
        guard let block = defaultInputListener else { return }
        var addr = CA.address(kAudioHardwarePropertyDefaultInputDevice)
        AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, control, block)
        defaultInputListener = nil
    }
}
