import AVFoundation
import Combine
import Foundation
@preconcurrency import Speech
import UIKit

/// Local microphone capture and explicitly on-device speech recognition.
/// Times emitted by onSegment are seconds relative to the current recording run.
@MainActor
final class MeetingRecorder: NSObject, ObservableObject {
    @Published private(set) var isRecording = false
    @Published private(set) var isStopping = false
    @Published private(set) var isPreparing = false
    let telemetry = RecordingTelemetry()
    private(set) var elapsedMs: Int {
        get { telemetry.elapsedMs }
        set { telemetry.elapsedMs = newValue }
    }
    private(set) var partialText: String {
        get { telemetry.partialText }
        set { if telemetry.partialText != newValue { telemetry.partialText = newValue } }
    }
    @Published private(set) var errorMessage: String?
    @Published private(set) var statusMessage = String(localized: "Audio and transcripts stay on this iPhone")
    @Published private(set) var recordingURL: URL?
    @Published private(set) var storageMessage: String?
    private var bytesPerSecond: Double = 0

    /// Persist only isFinal events. Partial events replace the live preview.
    var onSegment: ((String, Double, Double, Bool) -> Void)?
    var onResumeRequested: (() -> Void)?
    var onStopped: ((Bool) -> Void)?
    var onAudioSaved: ((String, Int) -> Void)?
    private var recovery = RecordingRecovery()
    private var warningAfterStop = false
    private var didReportAudio = false

    static var audioDirectory: URL { RecordingStorage.directory }

    // AVAudioSession is shared by the entire app. Keep ownership across view
    // navigation until pending permissions and final audio cleanup have ended.
    private static var sessionOwner: MeetingRecorder?

    private let engine = AVAudioEngine()
    private var hasTap = false
    private var sink: RecordingSink?
    private var recognizer: SFSpeechRecognizer?
    private var windows: [UUID: RecognitionWindow] = [:]
    private var windowOrder: [UUID] = []
    private var activeWindowID: UUID?
    private var isRotating = false
    private var isFlushing = false
    private var commitBarrierID: UUID?
    private var speechEnabled = false
    private var consecutiveRecognitionErrors = 0
    private var speechRetryAt: TimeInterval?
    private var clockTask: Task<Void, Never>?
    private var preparationID: UUID?
    private var observers: [NSObjectProtocol] = []
    private var stopMessage: String?

    override init() {
        super.init()
        observe(AVAudioSession.interruptionNotification) { recorder, notification in
            let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            if raw == AVAudioSession.InterruptionType.began.rawValue {
                if recorder.isRecording && !recorder.isStopping {
                    recorder.recovery.request(at: ProcessInfo.processInfo.systemUptime, awaitingInterruptionEnd: true)
                }
                recorder.stopForInterruption(
                    String(
                        localized: "A call or another audio app interrupted recording. Your recording has been saved."))
            } else if raw == AVAudioSession.InterruptionType.ended.rawValue {
                let options = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
                recorder.recovery.interruptionEnded(
                    shouldResume: AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume))
                recorder.resumeIfPossible()
            }
        }
        observe(AVAudioSession.routeChangeNotification) { recorder, notification in
            let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            if raw == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue
                || raw == AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue
            {
                // Connecting headphones should not interrupt the built-in room microphone.
                let session = AVAudioSession.sharedInstance()
                if recorder.isRecording && !recorder.isStopping
                    && (!recorder.engine.isRunning
                        || recorder.prefersBuiltInInput(session))
                {
                    recorder.recovery.request(at: ProcessInfo.processInfo.systemUptime)
                    recorder.stopForInterruption(String(localized: "The audio device changed. Resuming recording…"))
                }
            }
        }
        observe(.AVAudioEngineConfigurationChange) { recorder, notification in
            guard let changed = notification.object as? AVAudioEngine, changed === recorder.engine,
                recorder.isRecording, !recorder.isStopping, !recorder.engine.isRunning
            else { return }
            recorder.recovery.request(at: ProcessInfo.processInfo.systemUptime)
            recorder.stopForInterruption(
                String(localized: "The audio configuration changed. Saving and resuming recording…"))
        }
        observe(AVAudioSession.mediaServicesWereResetNotification) { recorder, _ in
            recorder.cancelAutomaticResume()
            recorder.stopForInterruption(
                String(localized: "System audio services reset. Your recording has been saved."))
        }
        observe(UIApplication.didEnterBackgroundNotification) { recorder, _ in
            // A call may background the app; keep its resume request for the next foreground event.
            recorder.stopForInterruption(
                String(localized: "The app moved to the background. Your recording has been saved."))
        }
        observe(UIApplication.didBecomeActiveNotification) { recorder, _ in recorder.resumeIfPossible() }
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        clockTask?.cancel()
    }

    func start(locale: String = "zh-CN", automatically: Bool = false, title: String = "Meeting") async {
        guard !isRecording, !isStopping, !isPreparing else { return }
        guard Self.sessionOwner == nil else {
            errorMessage = String(localized: "Another recording is running or being saved. Try again shortly.")
            return
        }
        if !automatically { recovery.reset() }
        speechRetryAt = nil
        recordingURL = nil
        elapsedMs = 0
        didReportAudio = false
        warningAfterStop = false
        Self.sessionOwner = self
        let preparation = UUID()
        preparationID = preparation
        isPreparing = true
        errorMessage = nil
        stopMessage = nil
        statusMessage = String(localized: "Checking microphone and on-device transcription permissions…")
        defer {
            if preparationID == preparation {
                preparationID = nil
            }
            // A cancelled permission prompt still owns preparation until it
            // returns, so a second start cannot race its cleanup.
            isPreparing = false
            if !isRecording { releaseSessionOwnership() }
        }

        do {
            let microphoneAllowed = await microphonePermission()
            try checkPreparation(preparation)
            guard microphoneAllowed else { throw RecorderError.microphoneDenied }
            let speechStatus = await speechPermission()
            try checkPreparation(preparation)

            let candidate = SFSpeechRecognizer(locale: Locale(identifier: locale))
            speechEnabled =
                speechStatus == .authorized && candidate?.supportsOnDeviceRecognition == true
                && candidate?.isAvailable == true
            recognizer = speechEnabled ? candidate : nil
            let fallback: String?
            if speechStatus != .authorized {
                fallback = String(localized: "Audio only: allow speech recognition in Settings to enable transcription")
            } else if candidate?.supportsOnDeviceRecognition != true {
                fallback = String(
                    localized:
                        "Audio only: on-device recognition is unavailable for this language. Audio is still saved on your phone."
                )
            } else if candidate?.isAvailable != true {
                fallback = String(localized: "Audio only: on-device speech recognition is temporarily unavailable")
            } else {
                fallback = nil
            }

            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [])
            try session.setActive(true)
            if prefersBuiltInInput(session),
                let microphone = session.availableInputs?.first(where: { $0.portType == .builtInMic })
            {
                try session.setPreferredInput(microphone)
            }
            try checkPreparation(preparation)
            let format = engine.inputNode.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                throw RecorderError.noInput
            }
            try FileManager.default.createDirectory(at: Self.audioDirectory, withIntermediateDirectories: true)
            bytesPerSecond =
                format.sampleRate * Double(format.streamDescription.pointee.mBytesPerFrame)
                * (format.isInterleaved ? 1 : Double(format.channelCount))
            let capacity = try await RecordingStorage.availableBytes(at: Self.audioDirectory)
            try checkPreparation(preparation)
            let minutes = RecordingStorage.minutesRemaining(capacity: capacity, bytesPerSecond: bytesPerSecond)
            guard minutes >= 1 else { throw RecorderError.lowStorage }
            storageMessage =
                minutes < 30
                ? String(
                    localized:
                        "Storage is low: about \(minutes) minutes of recording remain. Export and delete older recordings soon."
                ) : nil
            let url = Self.audioDirectory.appendingPathComponent(RecordingStorage.filename(title: title))
            let captureSink = try RecordingSink(url: url, format: format) { [weak self] message in
                Task { @MainActor [weak self] in
                    guard let self, self.isRecording, !self.isStopping else { return }
                    self.errorMessage = message
                    self.stopForInterruption(
                        String(localized: "Recording stopped. All successfully saved audio and text have been kept."))
                }
            }
            sink = captureSink
            recordingURL = url
            elapsedMs = 0
            partialText = ""
            consecutiveRecognitionErrors = 0
            windows.removeAll()
            windowOrder.removeAll()
            activeWindowID = nil
            engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                captureSink.enqueue(buffer)
            }
            hasTap = true
            engine.prepare()
            try checkPreparation(preparation)
            try engine.start()
            isRecording = true
            UIApplication.shared.isIdleTimerDisabled = true
            let languageName = locale == "en-US" ? "English" : String(localized: "Chinese")
            statusMessage = fallback ?? String(localized: "On-device transcription · \(languageName)")
            if speechEnabled { await beginRecognitionWindow() }
            startClock()
        } catch {
            UIApplication.shared.isIdleTimerDisabled = false
            engine.stop()
            removeTap()
            if let sink { elapsedMs = Int((await sink.finish() * 1000).rounded()) }
            sink = nil
            finishAudioFile()
            recognizer = nil
            speechEnabled = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            if error is CancellationError {
                statusMessage = String(localized: "Recording cancelled")
            } else {
                errorMessage = error.localizedDescription
                statusMessage = String(localized: "Recording did not start")
            }
        }
    }

    /// Stops audio immediately, then gives the recognizer a bounded finalization period.
    /// isRecording becomes false after the final callbacks have been emitted.
    func stop() async {
        preparationID = nil
        if isStopping {
            while isStopping { await finalizationTick() }
            return
        }
        guard isRecording else { return }
        isStopping = true
        UIApplication.shared.isIdleTimerDisabled = false
        let backgroundTask = UIApplication.shared.beginBackgroundTask(
            withName: "Save Chumi recording", expirationHandler: nil)
        defer {
            if backgroundTask != .invalid { UIApplication.shared.endBackgroundTask(backgroundTask) }
        }
        clockTask?.cancel()
        clockTask = nil
        engine.stop()
        removeTap()
        if let sink {
            let duration = await sink.finish()
            elapsedMs = Int((duration * 1000).rounded())
        }
        sink = nil
        activeWindowID = nil
        for window in windows.values where !window.finished {
            window.end = Double(elapsedMs) / 1000
        }
        let deadline = ProcessInfo.processInfo.systemUptime + 1.5
        while windows.values.contains(where: { !$0.finished }) && ProcessInfo.processInfo.systemUptime < deadline {
            // A caller cancelling its UI task must not cancel audio cleanup.
            await finalizationTick()
        }
        for window in windows.values {
            window.finished = true
            window.timeout?.cancel()
            window.task?.cancel()
        }
        commitFinishedWindows()
        while isFlushing { await finalizationTick() }
        partialText = ""
        telemetry.level = 0
        recognizer = nil
        speechEnabled = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        if warningAfterStop {
            warningAfterStop = false
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        }
        finishAudioFile()
        statusMessage = stopMessage ?? String(localized: "Saved on this iPhone")
        isStopping = false
        isRecording = false
        releaseSessionOwnership()
        let resume = takeAutomaticResume()
        onStopped?(resume)
        if resume { onResumeRequested?() }
    }

    /// Close the live window and commit its latest text before taking a sync snapshot.
    func flush(onBoundary: ((Int) -> Void)? = nil) async -> Int {
        while isRotating || isFlushing { await finalizationTick() }
        if isStopping { await stop(); onBoundary?(elapsedMs); return elapsedMs }
        guard isRecording else { onBoundary?(elapsedMs); return elapsedMs }
        isFlushing = true
        defer { isFlushing = false }
        let pending = Set(windowOrder)
        let offset =
            await beginRecognitionWindow(holdingCommit: true) ?? sink?.progress.duration ?? Double(elapsedMs) / 1000
        let deadline = ProcessInfo.processInfo.systemUptime + 1.6
        while pending.contains(where: { windows[$0] != nil }) && ProcessInfo.processInfo.systemUptime < deadline {
            await finalizationTick()
        }
        for id in pending {
            if let window = windows[id] { window.finished = true; window.end = offset; window.task?.cancel() }
        }
        commitFinishedWindows()
        let milliseconds = Int((offset * 1000).rounded(.down))
        onBoundary?(milliseconds)
        commitBarrierID = nil
        commitFinishedWindows()
        return milliseconds
    }

    @discardableResult
    private func beginRecognitionWindow(holdingCommit: Bool = false) async -> Double? {
        guard isRecording, !isStopping, speechEnabled, !isRotating,
            let recognizer, recognizer.supportsOnDeviceRecognition,
            let sink
        else { return nil }
        isRotating = true
        defer { isRotating = false }
        let previousID = activeWindowID
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        if #available(iOS 16.0, *) { request.addsPunctuation = true }
        let offset = await sink.replaceRequest(request)
        guard isRecording, !isStopping else { request.endAudio(); return nil }
        if let previousID, let previous = windows[previousID] {
            previous.end = offset
            scheduleFinalization(of: previousID)
        }
        let id = UUID()
        let window = RecognitionWindow(offset: offset)
        windows[id] = window
        windowOrder.append(id)
        activeWindowID = id
        if holdingCommit { commitBarrierID = id }
        partialText = ""
        window.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let snapshot = result.map { SpeechSnapshot(result: $0) }
            let message = error?.localizedDescription
            Task { @MainActor [weak self] in self?.receive(snapshot, error: message, windowID: id) }
        }
        return offset
    }

    private func receive(_ snapshot: SpeechSnapshot?, error: String?, windowID id: UUID) {
        guard let window = windows[id], !window.finished else { return }
        if let snapshot {
            window.latest = snapshot
            if !snapshot.text.isEmpty { consecutiveRecognitionErrors = 0 }
            if activeWindowID == id && !isStopping {
                partialText = snapshot.text
                onSegment?(
                    snapshot.text, window.offset + snapshot.start,
                    window.offset + snapshot.end, false)
            }
        }
        guard snapshot?.isFinal == true || error != nil else { return }
        window.finished = true
        window.timeout?.cancel()
        let needsRestart = activeWindowID == id && !isStopping
        if activeWindowID == id { activeWindowID = nil; partialText = "" }
        commitFinishedWindows()
        if error != nil, needsRestart {
            consecutiveRecognitionErrors += 1
            if consecutiveRecognitionErrors >= 3 {
                speechEnabled = false
                statusMessage = String(localized: "Audio only: on-device transcription is temporarily unavailable")
                errorMessage = String(
                    localized: "Transcription paused. Audio is still being saved. Retrying in 30 seconds.")
                speechRetryAt = ProcessInfo.processInfo.systemUptime + 30
                Task { [weak self] in _ = await self?.sink?.replaceRequest(nil) }
                return
            }
        }
        if needsRestart { Task { [weak self] in await self?.beginRecognitionWindow() } }
    }

    private func scheduleFinalization(of id: UUID) {
        guard let window = windows[id], !window.finished else { return }
        window.timeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 1_500_000_000) } catch { return }
            guard let self, let window = self.windows[id], !window.finished else { return }
            window.finished = true
            window.task?.cancel()
            self.commitFinishedWindows()
        }
    }

    private func commitFinishedWindows() {
        // Old callbacks cannot commit twice: remove the window before calling the store.
        while let id = windowOrder.first, id != commitBarrierID, let window = windows[id], window.finished {
            windowOrder.removeFirst()
            windows.removeValue(forKey: id)
            window.timeout?.cancel()
            window.task?.cancel()
            guard let snapshot = window.latest, !snapshot.text.isEmpty else { continue }
            let currentTime = max(Double(elapsedMs) / 1000, sink?.progress.duration ?? 0)
            let endLimit = max(window.offset, window.end ?? currentTime)
            let start = min(max(window.offset, window.offset + snapshot.start), endLimit)
            let estimatedEnd = snapshot.end > snapshot.start ? window.offset + snapshot.end : endLimit
            let end = min(max(start, estimatedEnd), endLimit)
            onSegment?(snapshot.text, start, end, true)
        }
    }

    private func startClock() {
        clockTask?.cancel()
        clockTask = Task { [weak self] in
            var lastStorageCheck = ProcessInfo.processInfo.systemUptime
            var lastFrames: Int64 = 0
            var lastProgress = ProcessInfo.processInfo.systemUptime
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 125_000_000) } catch { return }
                guard let self, self.isRecording, !self.isStopping else { return }
                guard let progress = self.sink?.progress else { return }
                let now = ProcessInfo.processInfo.systemUptime
                let elapsed = Int(progress.duration * 1000)
                reportSavedAudio(durationMs: elapsed)
                if elapsed / 1000 != self.elapsedMs / 1000 { self.elapsedMs = elapsed }
                let level =
                    UIAccessibility.isReduceMotionEnabled || ProcessInfo.processInfo.isLowPowerModeEnabled
                    ? 0 : progress.level
                if abs(self.telemetry.level - level) >= 0.02 { self.telemetry.level = level }
                if progress.receivedFrames > lastFrames {
                    lastFrames = progress.receivedFrames
                    lastProgress = now
                }
                if !self.engine.isRunning || now - lastProgress >= 2 {
                    self.recovery.request(at: now)
                    self.stopForInterruption(
                        String(localized: "No new microphone audio arrived. Saving and trying to resume recording…"))
                    return
                }
                if now - lastStorageCheck >= 10 {
                    lastStorageCheck = now
                    if let capacity = try? await RecordingStorage.availableBytes(at: Self.audioDirectory) {
                        guard !Task.isCancelled, self.isRecording, !self.isStopping else { return }
                        if capacity <= RecordingStorage.reserveBytes {
                            self.cancelAutomaticResume()
                            self.stopForInterruption(
                                String(
                                    localized:
                                        "Storage is full. Recording stopped and was saved. Export and delete older recordings to continue."
                                ))
                            return
                        }
                        let minutes = RecordingStorage.minutesRemaining(
                            capacity: capacity, bytesPerSecond: self.bytesPerSecond)
                        self.storageMessage =
                            minutes < 30
                            ? String(
                                localized:
                                    "Storage is low: about \(minutes) minutes of recording remain. Export and delete older recordings soon."
                            ) : nil
                    }
                }
                if progress.duration >= 10 { self.recovery.markHealthy() }
                if let retry = self.speechRetryAt, now >= retry {
                    self.speechRetryAt = now + 30
                    if self.recognizer?.isAvailable == true {
                        self.speechRetryAt = nil
                        self.speechEnabled = true
                        self.consecutiveRecognitionErrors = 0
                        self.errorMessage = nil
                        self.statusMessage = String(localized: "On-device transcription resumed")
                        await self.beginRecognitionWindow()
                    }
                }
                if let id = self.activeWindowID, let window = self.windows[id],
                    Double(self.elapsedMs) / 1000 - window.offset >= 45
                {
                    await self.beginRecognitionWindow()
                }
            }
        }
    }

    private func checkPreparation(_ id: UUID) throws {
        try Task.checkCancellation()
        guard preparationID == id else { throw CancellationError() }
    }

    private func releaseSessionOwnership() {
        if Self.sessionOwner === self { Self.sessionOwner = nil }
    }

    private func finalizationTick() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { continuation.resume() }
        }
    }

    private func removeTap() {
        if hasTap { engine.inputNode.removeTap(onBus: 0); hasTap = false }
    }

    private func stopForInterruption(_ message: String) {
        if isPreparing { preparationID = nil }
        guard isRecording, !isStopping else { return }
        stopMessage = message
        warningAfterStop = true
        Task { [weak self] in await self?.stop() }
    }

    func cancelAutomaticResume() { recovery.cancel() }

    private func takeAutomaticResume() -> Bool {
        guard onResumeRequested != nil, !isPreparing else { return false }
        let wasReady = recovery.requestedAt != nil && recovery.allowed
        let resume = recovery.takeResume(
            at: ProcessInfo.processInfo.systemUptime, active: UIApplication.shared.applicationState == .active)
        if wasReady && !resume && recovery.attempts >= 2 {
            errorMessage = String(
                localized: "Could not resume automatically. Check the microphone, then tap Resume recording.")
        }
        return resume
    }

    private func resumeIfPossible() {
        guard !isRecording, !isStopping, !isPreparing else { return }
        if takeAutomaticResume() { onResumeRequested?() }
    }

    private func prefersBuiltInInput(_ session: AVAudioSession) -> Bool {
        let inputs: [RecordingInputKind] = session.currentRoute.inputs.map {
            switch $0.portType {
            case .headsetMic, .bluetoothHFP: return .headset
            case .usbAudio, .lineIn: return .external
            case .builtInMic: return .builtIn
            default: return .other
            }
        }
        return RecordingRunPolicy.preferBuiltIn(over: inputs)
    }

    private func reportSavedAudio(durationMs: Int) {
        guard !didReportAudio, RecordingRunPolicy.keepAudio(durationMs: durationMs), let recordingURL else { return }
        didReportAudio = true
        onAudioSaved?(recordingURL.lastPathComponent, durationMs)
    }

    private func finishAudioFile() {
        if RecordingRunPolicy.keepAudio(durationMs: elapsedMs) {
            reportSavedAudio(durationMs: elapsedMs)
        } else if let url = recordingURL {
            try? FileManager.default.removeItem(at: url)
            recordingURL = nil
        }
    }

    func reportAutomaticResume() {
        if isRecording {
            statusMessage = String(localized: "Recording resumed automatically after an audio interruption")
        }
    }

    private func observe(
        _ name: Notification.Name,
        handler: @escaping @MainActor (MeetingRecorder, Notification) -> Void
    ) {
        observers.append(
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) {
                [weak self] notification in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    handler(self, notification)
                }
            })
    }

    private func microphonePermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        case .undetermined: return await AVAudioApplication.requestRecordPermission()
        @unknown default: return false
        }
    }

    private func speechPermission() async -> SFSpeechRecognizerAuthorizationStatus {
        let current = SFSpeechRecognizer.authorizationStatus()
        guard current == .notDetermined else { return current }
        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
    }
}

private enum RecorderError: LocalizedError {
    case microphoneDenied, noInput, lowStorage
    var errorDescription: String? {
        switch self {
        case .microphoneDenied:
            return String(localized: "Allow Chumi to record in Settings → Privacy & Security → Microphone.")
        case .lowStorage:
            return String(
                localized:
                    "Not enough storage to record. Export and delete older recordings to free up a few minutes of space, then try again."
            )
        case .noInput: return String(localized: "No microphone is available. Check your audio devices and try again.")
        }
    }
}

private struct SpeechSnapshot: Sendable {
    let text: String
    let start: Double
    let end: Double
    let isFinal: Bool
    init(result: SFSpeechRecognitionResult) {
        let transcription = result.bestTranscription
        text = String(transcription.formattedString.prefix(16_000)).trimmingCharacters(in: .whitespacesAndNewlines)
        start = max(0, transcription.segments.first?.timestamp ?? 0)
        let last = transcription.segments.last
        end = max(start, (last?.timestamp ?? 0) + (last?.duration ?? 0))
        isFinal = result.isFinal
    }
}

private final class RecognitionWindow {
    let offset: Double
    var end: Double?
    var latest: SpeechSnapshot?
    var finished = false
    var task: SFSpeechRecognitionTask?
    var timeout: Task<Void, Never>?
    init(offset: Double) { self.offset = offset }
}

/// All file and recognizer-buffer operations run in one FIFO queue. At most 64
/// copied buffers can be pending; an overloaded writer stops instead of growing RAM.
private final class RecordingSink: @unchecked Sendable {
    private let queue = DispatchQueue(label: "app.chumi.recording", qos: .userInitiated)
    private let capacity = DispatchSemaphore(value: 64)
    private let admissionLock = NSLock()
    private var accepting = true
    private var reportedFailure = false
    private var file: AVAudioFile?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var framesWritten: AVAudioFramePosition = 0
    private let progressLock = NSLock()
    private var writtenDuration: Double = 0
    private var receivedFrames: Int64 = 0
    private var level: Float = 0
    var progress: (duration: Double, receivedFrames: Int64, level: Float) {
        progressLock.lock(); defer { progressLock.unlock() }
        return (writtenDuration, receivedFrames, level)
    }
    private let sampleRate: Double
    private let onFailure: @Sendable (String) -> Void

    init(url: URL, format: AVAudioFormat, onFailure: @escaping @Sendable (String) -> Void) throws {
        self.sampleRate = format.sampleRate
        self.onFailure = onFailure
        // CAF is recoverable after an interrupted recording; PCM avoids holding
        // the complete meeting in memory and supports the input's native format.
        file = try AVAudioFile(
            forWriting: url, settings: format.settings,
            commonFormat: format.commonFormat, interleaved: format.isInterleaved)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
    }

    func enqueue(_ source: AVAudioPCMBuffer) {
        admissionLock.lock()
        guard accepting else { admissionLock.unlock(); return }
        progressLock.lock()
        receivedFrames += Int64(source.frameLength)
        progressLock.unlock()
        guard capacity.wait(timeout: .now()) == .success else {
            let shouldReport = !reportedFailure
            reportedFailure = true
            accepting = false
            admissionLock.unlock()
            if shouldReport {
                onFailure(
                    String(
                        localized:
                            "Audio could not be saved fast enough, so recording stopped safely. Check your storage and try again."
                    ))
            }
            return
        }
        guard let copy = AVAudioPCMBuffer(pcmFormat: source.format, frameCapacity: source.frameLength) else {
            capacity.signal()
            admissionLock.unlock()
            fail(String(localized: "Could not allocate an audio buffer. Recording will stop."))
            return
        }
        copy.frameLength = source.frameLength
        let sourceBuffers = UnsafeMutableAudioBufferListPointer(source.mutableAudioBufferList)
        let destinationBuffers = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for index in 0..<sourceBuffers.count {
            if let from = sourceBuffers[index].mData, let to = destinationBuffers[index].mData {
                memcpy(to, from, Int(sourceBuffers[index].mDataByteSize))
            }
        }
        queue.async { [self] in
            defer { capacity.signal() }
            guard let file else { return }
            do {
                try file.write(from: copy)
                framesWritten += AVAudioFramePosition(copy.frameLength)
                var rms: Float = 0
                if let samples = copy.floatChannelData?[0], copy.frameLength > 0 {
                    var count: Float = 0
                    for index in stride(from: 0, to: Int(copy.frameLength), by: 4) {
                        rms += samples[index] * samples[index]
                        count += 1
                    }
                    rms = sqrt(rms / max(1, count))
                }
                progressLock.lock()
                level = min(1, max(0, (20 * log10(max(rms, 0.00001)) + 60) / 60))
                writtenDuration = Double(framesWritten) / sampleRate
                progressLock.unlock()
                request?.append(copy)
            } catch {
                fail(String(localized: "Could not save audio: \(error.localizedDescription)"))
            }
        }
        admissionLock.unlock()
    }

    func replaceRequest(_ newRequest: SFSpeechAudioBufferRecognitionRequest?) async -> Double {
        await withCheckedContinuation { continuation in
            queue.async { [self] in
                request?.endAudio()
                request = file == nil ? nil : newRequest
                continuation.resume(returning: Double(framesWritten) / sampleRate)
            }
        }
    }

    func finish() async -> Double {
        stopAccepting()
        return await withCheckedContinuation { continuation in
            queue.async { [self] in
                request?.endAudio()
                request = nil
                file = nil
                continuation.resume(returning: Double(framesWritten) / sampleRate)
            }
        }
    }

    private func stopAccepting() {
        admissionLock.lock()
        accepting = false
        admissionLock.unlock()
    }

    private func fail(_ message: String) {
        admissionLock.lock()
        let shouldReport = !reportedFailure
        reportedFailure = true
        accepting = false
        admissionLock.unlock()
        if shouldReport { onFailure(message) }
    }
}

/// Fast-changing capture feedback is observed only by the readout and live transcript.
@MainActor
final class RecordingTelemetry: ObservableObject {
    @Published var elapsedMs = 0
    @Published var partialText = ""
    @Published var level: Float = 0
}
