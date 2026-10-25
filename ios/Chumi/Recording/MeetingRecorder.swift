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
    @Published private(set) var elapsedMs = 0
    @Published private(set) var partialText = ""
    @Published private(set) var errorMessage: String?
    @Published private(set) var statusMessage = "录音和转写保存在这台 iPhone 上"
    @Published private(set) var recordingURL: URL?

    /// Persist only isFinal events. Partial events replace the live preview.
    var onSegment: ((String, Double, Double, Bool) -> Void)?

    static var audioDirectory: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Recordings", isDirectory: true)
    }

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
    private var speechEnabled = false
    private var consecutiveRecognitionErrors = 0
    private var startedAt: TimeInterval = 0
    private var clockTask: Task<Void, Never>?
    private var preparationID: UUID?
    private var observers: [NSObjectProtocol] = []
    private var stopMessage: String?

    override init() {
        super.init()
        observe(AVAudioSession.interruptionNotification) { recorder, notification in
            let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            if raw == AVAudioSession.InterruptionType.began.rawValue {
                recorder.stopForInterruption("录音被来电或其他音频应用中断，已保存当前内容")
            }
        }
        observe(AVAudioSession.routeChangeNotification) { recorder, notification in
            let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            if raw == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue
                || raw == AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue
            {
                recorder.stopForInterruption("音频设备已切换，当前录音已保存；可重新开始录音")
            }
        }
        observe(AVAudioSession.mediaServicesWereResetNotification) { recorder, _ in
            recorder.stopForInterruption("系统音频服务已重置，当前录音已保存")
        }
        observe(UIApplication.didEnterBackgroundNotification) { recorder, _ in
            recorder.stopForInterruption("应用已进入后台，当前录音已保存")
        }
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        clockTask?.cancel()
    }

    func start(locale: String = "zh-CN") async {
        guard !isRecording, !isStopping, !isPreparing else { return }
        guard Self.sessionOwner == nil else {
            errorMessage = "另一段录音正在进行或保存，请稍后重试。"
            return
        }
        Self.sessionOwner = self
        let preparation = UUID()
        preparationID = preparation
        isPreparing = true
        errorMessage = nil
        stopMessage = nil
        statusMessage = "正在检查麦克风和设备端转写权限…"
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
                fallback = "仅录音：语音识别权限未开启，可在系统设置中允许"
            } else if candidate?.supportsOnDeviceRecognition != true {
                fallback = "仅录音：当前语言的设备端识别不可用；录音仍会保存在手机"
            } else if candidate?.isAvailable != true {
                fallback = "仅录音：设备端语音识别暂时不可用"
            } else {
                fallback = nil
            }

            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [.allowBluetooth])
            try session.setActive(true)
            try checkPreparation(preparation)
            let format = engine.inputNode.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                throw RecorderError.noInput
            }
            try FileManager.default.createDirectory(at: Self.audioDirectory, withIntermediateDirectories: true)
            let url = Self.audioDirectory.appendingPathComponent("\(UUID().uuidString).caf")
            let captureSink = try RecordingSink(url: url, format: format) { [weak self] message in
                Task { @MainActor [weak self] in
                    guard let self, self.isRecording, !self.isStopping else { return }
                    self.errorMessage = message
                    self.stopForInterruption("录音已停止，已保留成功写入的音频和文字")
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
            startedAt = ProcessInfo.processInfo.systemUptime
            isRecording = true
            statusMessage = fallback ?? "设备端转写中 · \(locale == "en-US" ? "English" : "中文")"
            if speechEnabled { await beginRecognitionWindow() }
            startClock()
        } catch {
            engine.stop()
            removeTap()
            if let sink { _ = await sink.finish() }
            sink = nil
            recognizer = nil
            speechEnabled = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            if error is CancellationError {
                statusMessage = "已取消录音"
            } else {
                errorMessage = error.localizedDescription
                statusMessage = "未开始录音"
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
        partialText = ""
        recognizer = nil
        speechEnabled = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        statusMessage = stopMessage ?? "已保存到这台 iPhone"
        isStopping = false
        isRecording = false
        releaseSessionOwnership()
    }

    private func beginRecognitionWindow() async {
        guard isRecording, !isStopping, speechEnabled, !isRotating,
            let recognizer, recognizer.supportsOnDeviceRecognition,
            let sink
        else { return }
        isRotating = true
        defer { isRotating = false }
        let previousID = activeWindowID
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        if #available(iOS 16.0, *) { request.addsPunctuation = true }
        let offset = await sink.replaceRequest(request)
        guard isRecording, !isStopping else { request.endAudio(); return }
        if let previousID, let previous = windows[previousID] {
            previous.end = offset
            scheduleFinalization(of: previousID)
        }
        let id = UUID()
        let window = RecognitionWindow(offset: offset)
        windows[id] = window
        windowOrder.append(id)
        activeWindowID = id
        partialText = ""
        window.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let snapshot = result.map { SpeechSnapshot(result: $0) }
            let message = error?.localizedDescription
            Task { @MainActor [weak self] in self?.receive(snapshot, error: message, windowID: id) }
        }
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
        if let error, needsRestart {
            consecutiveRecognitionErrors += 1
            if consecutiveRecognitionErrors >= 3 {
                speechEnabled = false
                statusMessage = "仅录音：设备端转写暂时不可用"
                errorMessage = "转写已暂停，录音仍在保存。\(error)"
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
        while let id = windowOrder.first, let window = windows[id], window.finished {
            windowOrder.removeFirst()
            windows.removeValue(forKey: id)
            window.timeout?.cancel()
            window.task?.cancel()
            guard let snapshot = window.latest, !snapshot.text.isEmpty else { continue }
            let currentTime =
                isStopping
                ? Double(elapsedMs) / 1000
                : max(Double(elapsedMs) / 1000, ProcessInfo.processInfo.systemUptime - startedAt)
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
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 250_000_000) } catch { return }
                guard let self, self.isRecording, !self.isStopping else { return }
                self.elapsedMs = Int((ProcessInfo.processInfo.systemUptime - self.startedAt) * 1000)
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
        Task { [weak self] in await self?.stop() }
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
    case microphoneDenied, noInput
    var errorDescription: String? {
        switch self {
        case .microphoneDenied: return "请在系统设置 → 隐私与安全性 → 麦克风中允许 Chumi 录音。"
        case .noInput: return "未找到可用的麦克风，请检查音频设备后重试。"
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

/// All file and recognizer-buffer operations run in one FIFO queue. At most eight
/// copied buffers can be pending; an overloaded writer stops instead of growing RAM.
private final class RecordingSink: @unchecked Sendable {
    private let queue = DispatchQueue(label: "app.chumi.recording", qos: .userInitiated)
    private let capacity = DispatchSemaphore(value: 8)
    private let admissionLock = NSLock()
    private var accepting = true
    private var reportedFailure = false
    private var file: AVAudioFile?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var framesWritten: AVAudioFramePosition = 0
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
        guard capacity.wait(timeout: .now()) == .success else {
            let shouldReport = !reportedFailure
            reportedFailure = true
            accepting = false
            admissionLock.unlock()
            if shouldReport { onFailure("音频写入未能跟上录音速度，已安全停止；请检查存储空间后重试。") }
            return
        }
        guard let copy = AVAudioPCMBuffer(pcmFormat: source.format, frameCapacity: source.frameLength) else {
            capacity.signal()
            admissionLock.unlock()
            fail("无法分配录音缓冲区，当前录音将停止。")
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
                request?.append(copy)
            } catch {
                fail("保存录音失败：\(error.localizedDescription)")
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
