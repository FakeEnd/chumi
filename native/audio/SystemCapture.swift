// SystemCapture.swift — computer ("system") audio via a Core Audio process tap (macOS 14.2+).
//
// Global stereo tap (excluding this process) → private aggregate device whose main sub-device is the
// current default output → IOProc → mono → SourcePipeline. Rebuilt whenever the default output device
// (or its sample rate) changes. Public methods are called on the main queue; all Core Audio work runs
// on a private serial `control` queue, because creating the tap / IOProc can block for as long as the
// macOS "System Audio Recording" permission prompt is on screen.

import Foundation
import CoreAudio
import AudioToolbox

final class SystemCapture {
    let pipeline: SourcePipeline

    private(set) var outputName: String?
    private(set) var running = false

    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var outputDeviceID = AudioObjectID(kAudioObjectUnknown)

    private var defaultOutputListener: AudioObjectPropertyListenerBlock?
    private var rateListener: AudioObjectPropertyListenerBlock?
    private var rateListenerDevice = AudioObjectID(kAudioObjectUnknown)
    private var rebuildWork: DispatchWorkItem?
    private var stopped = false
    private let control = DispatchQueue(label: "local.chumi.audio.system.control", qos: .userInitiated)
    private let silence: SilenceWatch
    static let silenceSeconds: Double = 15

    init(pipeline: SourcePipeline) {
        self.pipeline = pipeline
        self.silence = SilenceWatch(pipeline: pipeline, threshold: 1e-6, seconds: SystemCapture.silenceSeconds, code: "system_silent") {
            "No system audio signal for \(Int(SystemCapture.silenceSeconds)) s. Either nothing is playing, or System Audio Recording permission has not been granted (System Settings → Privacy & Security → Screen & System Audio Recording → System Audio Recording Only)."
        }
    }

    /// Starts capture asynchronously; `completion(true)` (on the main queue) once the tap is running.
    /// Emits an error event on failure.
    func start(completion: @escaping (Bool) -> Void) {
        silence.start()
        // Creating the tap/IOProc blocks while macOS shows the System Audio Recording prompt (or while an
        // earlier prompt is still unanswered). Tell the UI instead of silently hanging.
        let lock = NSLock()
        var finished = false
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
            lock.lock(); let report = !finished; lock.unlock()
            if report {
                EventLog.warning("system_permission_pending", "Waiting for macOS to allow computer-audio capture. If a \"System Audio Recording\" permission prompt is open, choose Allow (System Settings → Privacy & Security → Screen & System Audio Recording).")
            }
        }
        let done: (Bool) -> Void = { ok in
            lock.lock(); finished = true; lock.unlock()
            DispatchQueue.main.async { completion(ok) }
        }
        control.async {
            self.installDefaultOutputListener()
            var ok = false
            do {
                try self.build()
                ok = true
            } catch let e as CaptureError {
                EventLog.error(e.code, e.message)
            } catch {
                EventLog.error("system_tap_failed", "Could not start computer-audio capture: \(error)")
            }
            if !ok { self.teardown() }
            done(ok)
        }
    }

    /// Tears everything down. Waits until `deadline` at most (the control queue may be stuck in a
    /// permission prompt; process exit cleans up private taps/aggregates anyway).
    func stop(deadline: DispatchTime = .now() + 1.5) {
        silence.stop()
        let done = DispatchSemaphore(value: 0)
        control.async {
            self.stopped = true
            self.rebuildWork?.cancel()
            self.rebuildWork = nil
            self.removeDefaultOutputListener()
            self.teardown()
            done.signal()
        }
        _ = done.wait(timeout: deadline)
    }

    // MARK: - Build / teardown

    private func build() throws {
        guard #available(macOS 14.2, *) else {
            throw CaptureError(code: "system_tap_unsupported",
                               message: "Capturing computer audio needs macOS 14.2 or later. Update macOS, or use microphone-only capture.")
        }
        guard let outDev = CA.defaultOutputDevice(), let outUID = CA.uid(outDev) else {
            throw CaptureError(code: "system_tap_failed",
                               message: "No audio output device is available. Pick an output in System Settings → Sound → Output.")
        }
        outputDeviceID = outDev
        outputName = CA.name(outDev)

        // 1. Process tap on everything except ourselves.
        let exclude: [AudioObjectID] = CA.processObject(pid: getpid()).map { [$0] } ?? []
        let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: exclude)
        desc.uuid = UUID()
        desc.name = "Chumi System Audio Tap"
        desc.isPrivate = true
        desc.muteBehavior = .unmuted

        var tap = AudioObjectID(kAudioObjectUnknown)
        var status = AudioHardwareCreateProcessTap(desc, &tap)
        guard status == noErr, tap != kAudioObjectUnknown else {
            let unsupported = status == OSStatus(kAudioHardwareUnsupportedOperationError) || status == OSStatus(kAudioHardwareIllegalOperationError)
            throw CaptureError(code: unsupported ? "system_tap_unsupported" : "system_tap_failed",
                               message: "Could not create the system-audio tap (\(fourCC(status))). Check System Settings → Privacy & Security → Screen & System Audio Recording (\"System Audio Recording Only\") and allow Chumi.")
        }
        tapID = tap

        guard let tapFormat = CA.tapFormat(tap), tapFormat.mSampleRate > 0 else {
            throw CaptureError(code: "system_tap_failed", message: "Could not read the system-audio tap format.")
        }
        guard (tapFormat.mFormatFlags & kAudioFormatFlagIsFloat) != 0, tapFormat.mBitsPerChannel == 32 else {
            throw CaptureError(code: "system_tap_failed", message: "Unexpected system-audio tap format: \(CA.describe(tapFormat)).")
        }

        // 2. Private aggregate device: main sub-device = current output, plus the tap.
        let aggregateUID = "local.chumi.audio.aggregate.\(UUID().uuidString)"
        let description: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Chumi System Audio",
            kAudioAggregateDeviceUIDKey: aggregateUID,
            kAudioAggregateDeviceMainSubDeviceKey: outUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [
                [kAudioSubDeviceUIDKey: outUID],
            ],
            kAudioAggregateDeviceTapListKey: [
                [kAudioSubTapUIDKey: desc.uuid.uuidString, kAudioSubTapDriftCompensationKey: true],
            ],
        ]
        var agg = AudioObjectID(kAudioObjectUnknown)
        status = AudioHardwareCreateAggregateDevice(description as CFDictionary, &agg)
        guard status == noErr, agg != kAudioObjectUnknown else {
            throw CaptureError(code: "system_tap_failed", message: "Could not create the capture aggregate device (\(fourCC(status))).")
        }
        aggregateID = agg

        // 3. Work out which input buffers belong to the tap. Aggregate input streams are the
        //    sub-device's own input streams (if the output device also has a mic, e.g. a headset)
        //    followed by the tap stream(s).
        let subInputStreams = CA.streamCount(outDev, scope: kAudioObjectPropertyScopeInput)
        let aggInputStreams = CA.streamCount(agg, scope: kAudioObjectPropertyScopeInput)
        let rate = CA.nominalSampleRate(agg).flatMap { $0 > 0 ? $0 : nil } ?? tapFormat.mSampleRate
        let firstTapBuffer = aggInputStreams > subInputStreams ? subInputStreams : 0
        EventLog.debug("system: output=\"\(outputName ?? "?")\" tap=\(CA.describe(tapFormat)) aggregateRate=\(rate) subInputStreams=\(subInputStreams) aggInputStreams=\(aggInputStreams) firstTapBuffer=\(firstTapBuffer) excludeSelf=\(!exclude.isEmpty)")

        // 4. IOProc. Runs on the real-time IO thread: only downmix into a fresh array and hand off.
        let pipeline = self.pipeline
        var loggedLayout = false
        let block: AudioDeviceIOBlock = { _, inInputData, inInputTime, _, _ in
            let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
            let count = abl.count
            guard count > 0 else { return }
            let start = count > firstTapBuffer ? firstTapBuffer : 0

            var frames = 0
            var totalChannels = 0
            for i in start..<count {
                let b = abl[i]
                guard b.mData != nil, b.mDataByteSize > 0 else { continue }
                let ch = max(1, Int(b.mNumberChannels))
                frames = max(frames, Int(b.mDataByteSize) / (4 * ch))
                totalChannels += ch
            }
            guard frames > 0, totalChannels > 0 else { return }

            var mono = [Float](repeating: 0, count: frames)
            mono.withUnsafeMutableBufferPointer { dst in
                for i in start..<count {
                    let b = abl[i]
                    guard let data = b.mData, b.mDataByteSize > 0 else { continue }
                    let ch = max(1, Int(b.mNumberChannels))
                    let f = min(frames, Int(b.mDataByteSize) / (4 * ch))
                    let p = data.assumingMemoryBound(to: Float.self)
                    if ch == 1 {
                        for k in 0..<f { dst[k] += p[k] }
                    } else if ch == 2 {
                        for k in 0..<f { dst[k] += p[2 * k] + p[2 * k + 1] }
                    } else {
                        for k in 0..<f {
                            var s: Float = 0
                            for c in 0..<ch { s += p[k * ch + c] }
                            dst[k] += s
                        }
                    }
                }
                let scale = 1 / Float(totalChannels)
                for k in 0..<frames { dst[k] *= scale }
            }

            let ts = inInputTime.pointee
            let host: Double? = (ts.mFlags.contains(.hostTimeValid) && ts.mHostTime != 0)
                ? Clock.seconds(hostTime: ts.mHostTime) : nil
            let describeLayout = !loggedLayout && Options.debug
            loggedLayout = true
            pipeline.queue.async {
                if describeLayout {
                    EventLog.debug("system: IOProc buffers=\(count) using=\(start)..<\(count) channels=\(totalChannels) frames=\(frames)")
                }
                pipeline.push(mono, rate: rate, hostSeconds: host)
            }
        }

        var proc: AudioDeviceIOProcID?
        status = AudioDeviceCreateIOProcIDWithBlock(&proc, agg, nil, block)
        guard status == noErr, let proc else {
            throw CaptureError(code: "system_tap_failed", message: "Could not create the capture IO callback (\(fourCC(status))).")
        }
        procID = proc

        // Do not run the output device's own input (e.g. a Bluetooth headset mic) — we only want the tap.
        if subInputStreams > 0 && firstTapBuffer > 0 {
            setInputStreamUsage(device: agg, proc: proc) { $0 >= firstTapBuffer }
        }

        status = AudioDeviceStart(agg, proc)
        guard status == noErr else {
            throw CaptureError(code: "system_tap_failed",
                               message: "Could not start computer-audio capture (\(fourCC(status))). Check System Settings → Privacy & Security → Screen & System Audio Recording.")
        }
        running = true
        installRateListener(device: outDev)
    }

    private func teardown() {
        removeRateListener()
        if aggregateID != kAudioObjectUnknown {
            if let procID {
                AudioDeviceStop(aggregateID, procID)
                AudioDeviceDestroyIOProcID(aggregateID, procID)
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
        }
        procID = nil
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        if tapID != kAudioObjectUnknown {
            if #available(macOS 14.2, *) {
                AudioHardwareDestroyProcessTap(tapID)
            }
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
        running = false
    }

    /// Enable only the IOProc input streams for which `enabled(index)` is true (best effort).
    private func setInputStreamUsage(device: AudioObjectID, proc: AudioDeviceIOProcID, enabled: (Int) -> Bool) {
        var addr = CA.address(kAudioDevicePropertyIOProcStreamUsage, kAudioObjectPropertyScopeInput)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &addr, 0, nil, &size) == noErr, size >= 16 else { return }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 8)
        defer { raw.deallocate() }
        raw.initializeMemory(as: UInt8.self, repeating: 0, count: Int(size))
        // struct AudioHardwareIOProcStreamUsage { void* mIOProc; UInt32 mNumberStreams; UInt32 mStreamIsOn[]; }
        raw.storeBytes(of: unsafeBitCast(proc, to: UnsafeMutableRawPointer.self), as: UnsafeMutableRawPointer.self)
        guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, raw) == noErr else { return }
        let n = Int(raw.load(fromByteOffset: 8, as: UInt32.self))
        for i in 0..<n where 12 + 4 * i + 4 <= Int(size) {
            raw.storeBytes(of: UInt32(enabled(i) ? 1 : 0), toByteOffset: 12 + 4 * i, as: UInt32.self)
        }
        let st = AudioObjectSetPropertyData(device, &addr, 0, nil, size, raw)
        EventLog.debug("system: disabled sub-device input streams (status \(st), streams \(n))")
    }

    // MARK: - Device changes

    private func installDefaultOutputListener() {
        guard defaultOutputListener == nil else { return }
        var addr = CA.address(kAudioHardwarePropertyDefaultOutputDevice)
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.scheduleRebuild(force: false, attempt: 0)
        }
        if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, control, block) == noErr {
            defaultOutputListener = block
        }
    }

    private func removeDefaultOutputListener() {
        guard let block = defaultOutputListener else { return }
        var addr = CA.address(kAudioHardwarePropertyDefaultOutputDevice)
        AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, control, block)
        defaultOutputListener = nil
    }

    private func installRateListener(device: AudioObjectID) {
        removeRateListener()
        var addr = CA.address(kAudioDevicePropertyNominalSampleRate)
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.scheduleRebuild(force: true, attempt: 0)
        }
        if AudioObjectAddPropertyListenerBlock(device, &addr, control, block) == noErr {
            rateListener = block
            rateListenerDevice = device
        }
    }

    private func removeRateListener() {
        guard let block = rateListener else { return }
        var addr = CA.address(kAudioDevicePropertyNominalSampleRate)
        AudioObjectRemovePropertyListenerBlock(rateListenerDevice, &addr, control, block)
        rateListener = nil
        rateListenerDevice = AudioObjectID(kAudioObjectUnknown)
    }

    private func scheduleRebuild(force: Bool, attempt: Int) {
        guard !stopped else { return }
        rebuildWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.rebuild(force: force, attempt: attempt) }
        rebuildWork = work
        control.asyncAfter(deadline: .now() + (attempt == 0 ? 0.5 : 2.0), execute: work)
    }

    private func rebuild(force: Bool, attempt: Int) {
        guard !stopped else { return }
        let newOutput = CA.defaultOutputDevice() ?? AudioObjectID(kAudioObjectUnknown)
        if !force && running && newOutput == outputDeviceID { return }
        teardown()
        let pipeline = self.pipeline
        pipeline.queue.async { pipeline.reset() }
        do {
            try build()
            silence.rearm()
            EventLog.emit(["type": "device_changed", "kind": "output", "name": .str(outputName)])
        } catch {
            teardown()
            if attempt < 5 {
                scheduleRebuild(force: true, attempt: attempt + 1)
            } else if let e = error as? CaptureError {
                EventLog.error(e.code, e.message)
            } else {
                EventLog.error("system_tap_failed", "Could not restart computer-audio capture: \(error)")
            }
        }
    }
}
