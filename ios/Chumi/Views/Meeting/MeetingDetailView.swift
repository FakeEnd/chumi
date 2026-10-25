import SwiftUI

/// One meeting: recording, sync to the Mac, the transcript and the assistant.
/// This view owns the recording run and every request to the Mac; the panels it shows only render.
struct MeetingDetailView: View {
    enum Tab: Hashable { case transcript, assistant }

    let meetingId: UUID
    @EnvironmentObject private var store: MeetingStore
    @EnvironmentObject private var connection: ConnectionStore
    @Environment(\.dismiss) private var dismiss
    @StateObject private var recorder = MeetingRecorder()

    @State private var tab: Tab = DemoScreen.requested == .assistant ? .assistant : .transcript
    @State private var locale = "zh-CN"

    // The current recording run. Its segment times are offset by the meeting's earlier duration.
    @State private var baseDuration = 0
    @State private var recordingRunActive = false
    @State private var starting = false
    @State private var recordingTask: Task<Void, Never>?

    // Requests to the Mac.
    @State private var busy = false
    @State private var error: String?
    @State private var operation: Task<Void, Never>?
    @State private var projects: [MobileProject] = []

    // Assistant and note input.
    @State private var question = ""
    @State private var projectContext = false
    @State private var catchupScope = "2m"
    @State private var note = ""

    @State private var showConnection = false
    @State private var showNote = false
    @State private var showDelete = false
    @State private var showProjects = false

    private var meeting: Meeting? { store.meeting(meetingId) }
    private var recordingBusy: Bool { recorder.isRecording || recorder.isStopping || recorder.isPreparing || starting }
    private var recordingTransition: Bool { recorder.isStopping || recorder.isPreparing || starting }
    private var connectedIdentity: String? {
        connection.credentials.map { $0.url + "|" + ($0.certificateSHA256 ?? "system-trust") }
    }

    /// Whether the currently paired Mac holds this meeting's latest revision.
    private func isSyncedHere(_ meeting: Meeting) -> Bool {
        meeting.isSynced && meeting.syncedServer == connectedIdentity
    }

    private var canAsk: Bool {
        guard let meeting else { return false }
        return !store.isReadOnly && !busy && !recordingTransition && isSyncedHere(meeting) && !meeting.segments.isEmpty
    }

    var body: some View {
        Group {
            if let meeting {
                content(meeting)
            } else {
                ContentUnavailableView("找不到会议", systemImage: "doc.text.magnifyingglass")
            }
        }
        .background(ChumiBackground())
        .sheet(isPresented: $showConnection) { ConnectionView() }
        .sheet(isPresented: $showNote) { NoteSheet(note: $note, canSave: !recordingBusy, onSave: addNote) }
        .sheet(isPresented: $showProjects) {
            ProjectPickerSheet(projects: projects, selectedId: meeting?.projectId, onSelect: assignProject)
        }
        .confirmationDialog("删除这部 iPhone 上的会议？", isPresented: $showDelete, titleVisibility: .visible) {
            Button("删除会议", role: .destructive, action: deleteMeeting)
        } message: {
            Text("Mac 上的副本不受影响。录音文件仍保留在“文件”App 的 Chumi / Recordings 中，可单独管理。")
        }
        .onAppear(perform: attachRecorder)
        .onChange(of: recorder.isRecording) { wasRecording, isRecording in
            if wasRecording && !isRecording { finishRecording() }
        }
        .onDisappear {
            operation?.cancel()
            recordingTask?.cancel()
            Task {
                await recorder.stop()
                finishRecording()
            }
        }
    }

    // MARK: Layout

    private func content(_ meeting: Meeting) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                MeetingHeader(
                    meeting: meeting,
                    isRecording: recorder.isRecording,
                    isSynced: isSyncedHere(meeting),
                    projectName: projects.first { $0.id == meeting.projectId }?.name)
                RecorderCard(
                    recorder: recorder,
                    displayMs: recordingRunActive ? baseDuration + recorder.elapsedMs : meeting.durationMs,
                    locale: $locale,
                    audioFiles: meeting.audioFiles,
                    isStarting: starting,
                    canStart: !starting && !busy && !store.isReadOnly,
                    canChangeLanguage: !starting && !store.isReadOnly,
                    canExport: !recordingBusy,
                    onStart: startRecording,
                    onStop: stopRecording)
                if let error { Notice(message: error) }
                if let error = recorder.errorMessage { Notice(message: error) }
                if let error = store.errorMessage { Notice(message: error) }
                SyncCard(
                    isPaired: connection.credentials != nil,
                    isSynced: isSyncedHere(meeting),
                    isRecording: recorder.isRecording,
                    busy: busy,
                    canSync: !busy && !recordingTransition && !store.isReadOnly,
                    canPickProject: !busy && !recordingBusy && !store.isReadOnly,
                    onConnect: { showConnection = true },
                    onSync: syncMeeting,
                    onPickProject: loadProjects)
                SegmentedControl(
                    selection: $tab,
                    options: [
                        SegmentOption(.transcript, "转写 · \(meeting.segments.count)"),
                        SegmentOption(.assistant, meeting.outputs.isEmpty ? "助手" : "助手 · \(meeting.outputs.count)"),
                    ])
                switch tab {
                case .transcript:
                    TranscriptPanel(
                        segments: meeting.segments,
                        partialText: recorder.partialText,
                        isRecording: recorder.isRecording,
                        canAddNote: !recordingBusy && !store.isReadOnly,
                        onAddNote: { showNote = true })
                case .assistant:
                    AssistantPanel(
                        outputs: meeting.outputs,
                        hasProject: meeting.projectId != nil,
                        canAsk: canAsk,
                        canRefresh: !busy && !store.isReadOnly && meeting.syncedServer == connectedIdentity,
                        isReadOnly: store.isReadOnly,
                        question: $question,
                        projectContext: $projectContext,
                        scope: $catchupScope,
                        onCatchup: { runAI(kind: "catchup") },
                        onSummary: { runAI(kind: "summary") },
                        onAsk: { runAI(kind: "answer") },
                        onRefresh: refreshOutput)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 32)
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 6) {
                    TypeDot(type: meeting.type, size: 8)
                    Text(meeting.typeLabel).font(.subheadline.weight(.semibold)).foregroundStyle(ChumiTheme.text)
                }
            }
            ToolbarItem(placement: .topBarTrailing) { actionsMenu(meeting) }
        }
    }

    private func actionsMenu(_ meeting: Meeting) -> some View {
        Menu {
            Button("添加文字笔记", systemImage: "square.and.pencil") { showNote = true }
                .disabled(recordingBusy || store.isReadOnly)
            Button("选择 Mac 上的项目", systemImage: "folder", action: loadProjects)
                .disabled(recordingBusy || busy || store.isReadOnly)
            Button("连接 Mac", systemImage: "desktopcomputer") { showConnection = true }
            if !meeting.segments.isEmpty {
                ShareLink(item: transcriptText(meeting)) {
                    Label("导出文字", systemImage: "square.and.arrow.up")
                }
            }
            Divider()
            Button("删除手机上的会议", systemImage: "trash", role: .destructive) { showDelete = true }
                .disabled(recordingBusy || busy || store.isReadOnly)
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("会议操作")
    }

    private func transcriptText(_ meeting: Meeting) -> String {
        meeting.segments.map { "[\(durationLabel($0.tStart))] \($0.text)" }.joined(separator: "\n\n")
    }

    // MARK: Recording

    private func attachRecorder() {
        recorder.onSegment = { text, from, to, isFinal in
            guard isFinal, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            let start = baseDuration + max(0, Int(from * 1000))
            let end = baseDuration + max(0, Int(to * 1000))
            store.update(meetingId) {
                $0.segments.append(.init(tStart: start, tEnd: max(start, end), text: text, lang: locale))
                $0.durationMs = max($0.durationMs, end)
            }
        }
    }

    private func startRecording() {
        guard let meeting, !store.isReadOnly, !recordingBusy else { return }
        error = nil
        baseDuration = meeting.durationMs
        starting = true
        recordingTask = Task {
            defer { starting = false }
            await recorder.start(locale: locale)
            guard recorder.isRecording else { return }
            recordingRunActive = true
            store.update(meetingId) {
                $0.status = "recording"
                if let file = recorder.recordingURL?.lastPathComponent, !$0.audioFiles.contains(file) {
                    $0.audioFiles.append(file)
                }
            }
        }
    }

    private func stopRecording() {
        recordingTask = Task {
            await recorder.stop()
            finishRecording()
        }
    }

    private func finishRecording() {
        guard recordingRunActive else { return }
        recordingRunActive = false
        store.update(meetingId) {
            $0.status = "ended"
            $0.durationMs = max($0.durationMs, baseDuration + recorder.elapsedMs)
            if let file = recorder.recordingURL?.lastPathComponent, !$0.audioFiles.contains(file) {
                $0.audioFiles.append(file)
            }
        }
    }

    // MARK: Notes, projects and deletion

    private func addNote() {
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
        store.update(meetingId) {
            $0.segments.append(
                .init(tStart: $0.durationMs, tEnd: $0.durationMs, text: TranscriptSegment.notePrefix + text, lang: nil))
        }
        note = ""
        showNote = false
    }

    private func assignProject(_ id: String?) {
        store.update(meetingId) { $0.projectId = id }
        projectContext = false
        showProjects = false
    }

    private func deleteMeeting() {
        do {
            try store.remove(meetingId)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: Mac requests

    private func syncMeeting() {
        perform {
            guard !recordingTransition else { return }
            if recordingRunActive {
                store.update(meetingId) { $0.durationMs = max($0.durationMs, baseDuration + recorder.elapsedMs) }
            }
            guard let meeting else { throw MeetingError.unavailable }
            let client = try connection.client()
            let identity = connectedIdentity
            let snapshotRevision = meeting.revision
            let result = try await client.sync(meeting)
            try Task.checkCancellation()
            store.update(meetingId, contentChanged: false) {
                $0.remoteId = result.id
                $0.syncedRevision = snapshotRevision
                $0.syncedServer = identity
            }
        }
    }

    private func loadProjects() {
        guard connection.credentials != nil else {
            showConnection = true
            return
        }
        perform {
            projects = try await connection.client().projects()
            try Task.checkCancellation()
            showProjects = true
        }
    }

    private func runAI(kind: String) {
        guard canAsk else { return }
        let prompt = question.trimmingCharacters(in: .whitespacesAndNewlines)
        let scope = catchupScope
        perform {
            guard let meeting, let remoteId = meeting.remoteId else { throw MeetingError.needsSync }
            let client = try connection.client()
            let ticket: OutputTicket
            switch kind {
            case "catchup":
                ticket = try await client.catchup(sessionId: remoteId, scope: scope)
            case "summary":
                ticket = try await client.summary(sessionId: remoteId)
            default:
                ticket = try await client.ask(sessionId: remoteId, question: prompt, projectContext: projectContext)
            }
            let pending = AssistantOutput(
                id: ticket.id, kind: kind, status: "pending",
                question: kind == "answer" ? prompt : nil,
                scope: kind == "catchup" ? scope : nil)
            store.saveOutput(pending, meetingId: meetingId)
            if kind == "answer" { question = "" }
            try await poll(ticket.id, client: client)
        }
    }

    private func refreshOutput(_ id: String) {
        perform { try await poll(id, client: connection.client()) }
    }

    private func poll(_ id: String, client: MobileAPI) async throws {
        let deadline = Date().addingTimeInterval(180)
        while Date() < deadline {
            try Task.checkCancellation()
            let output = try await client.output(id: id)
            try Task.checkCancellation()
            store.saveOutput(output, meetingId: meetingId)
            if output.isFinished { return }
            try await Task.sleep(nanoseconds: 1_200_000_000)
        }
        throw MeetingError.pollingTimeout
    }

    /// Runs one request to the Mac at a time and shows its error, unless it was cancelled.
    private func perform(_ work: @escaping @MainActor () async throws -> Void) {
        guard !store.isReadOnly, !busy else { return }
        error = nil
        busy = true
        operation = Task {
            defer { busy = false }
            do {
                try await work()
            } catch is CancellationError {
            } catch {
                if !Task.isCancelled { self.error = error.localizedDescription }
            }
        }
    }
}

/// Date, title and state badges at the top of the meeting.
private struct MeetingHeader: View {
    let meeting: Meeting
    let isRecording: Bool
    let isSynced: Bool
    let projectName: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(meeting.date, format: .dateTime.year().month().day().hour().minute())
                .font(.footnote)
                .foregroundStyle(ChumiTheme.muted)
            Text(meeting.title)
                .font(.title2.weight(.bold))
                .foregroundStyle(ChumiTheme.text)
                .fixedSize(horizontal: false, vertical: true)
            FlowLayout(spacing: 6) {
                if isRecording {
                    Badge(text: "录音中", tone: .live)
                } else {
                    Badge(text: "保存在这台 iPhone", tone: .muted, systemImage: "iphone")
                }
                if isSynced {
                    Badge(text: "已同步到 Mac", tone: .ok, systemImage: "checkmark")
                } else if meeting.remoteId != nil {
                    Badge(text: "有新内容待同步", tone: .warn, systemImage: "arrow.triangle.2.circlepath")
                }
                if meeting.projectId != nil {
                    Badge(text: projectName ?? "已关联项目", tone: .accent, systemImage: "folder")
                }
            }
        }
        .padding(.horizontal, 4)
    }
}
