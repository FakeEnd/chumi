import SwiftUI

/// One meeting: recording, sync to the Mac, the transcript and the assistant.
/// Recording belongs to this screen; the meeting store keeps assistant polling alive after navigation.
struct MeetingDetailView: View {
    enum Tab: Hashable { case transcript, assistant }

    let meetingId: UUID
    @EnvironmentObject private var store: MeetingStore
    @EnvironmentObject private var connection: ConnectionStore
    @Environment(\.dismiss) private var dismiss
    @StateObject private var recorder = MeetingRecorder()

    @State private var tab: Tab = DemoScreen.requested == .assistant ? .assistant : .transcript
    @AppStorage("recognitionLocale") private var defaultLocale = Meeting.defaultRecognitionLocale
    @State private var locale = Meeting.defaultRecognitionLocale

    // The current recording run. Its segment times are offset by the meeting's earlier duration.
    @State private var baseDuration = 0
    @State private var recordingRunActive = false
    @State private var starting = false
    @State private var recordingTask: Task<Void, Never>?

    // Requests to the Mac.
    @State private var busy = false
    @State private var error: String?
    @State private var recovery: String?
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
    @State private var showLeaveRecording = false
    @State private var showSyncCopy = false

    private var meeting: Meeting? { store.meeting(meetingId) }
    private var recordingBusy: Bool { recorder.isRecording || recorder.isStopping || recorder.isPreparing || starting }
    private var recordingTransition: Bool { recorder.isStopping || recorder.isPreparing || starting }
    private var connectedIdentity: String? {
        connection.identity
    }

    /// Whether the currently paired Mac holds this meeting's latest revision.
    private func isSyncedHere(_ meeting: Meeting) -> Bool {
        meeting.isSynced && meeting.syncedServer == connectedIdentity
    }

    private var canAsk: Bool {
        guard let meeting else { return false }
        return !store.isReadOnly && !busy && !recordingTransition && connection.credentials != nil
            && (!meeting.segments.isEmpty || recorder.isRecording)
    }

    var body: some View {
        Group {
            if let meeting {
                content(meeting)
            } else {
                ContentUnavailableView(String(localized: "Meeting not found"), systemImage: "doc.text.magnifyingglass")
            }
        }
        .background(ChumiBackground())
        .background(RecordingNavigationGuard(isLocked: recordingBusy))
        .navigationBarBackButtonHidden(recordingBusy)
        .confirmationDialog(
            String(localized: "Stop recording and go back?"), isPresented: $showLeaveRecording,
            titleVisibility: .visible
        ) {
            Button(String(localized: "Stop recording and go back"), role: .destructive) {
                recorder.cancelAutomaticResume()
                recordingTask?.cancel()
                recordingTask = Task {
                    await recorder.stop()
                    finishRecording()
                    dismiss()
                }
            }
            Button(String(localized: "Keep recording"), role: .cancel) {}
        }
        .sheet(isPresented: $showConnection) { ConnectionView() }
        .sheet(isPresented: $showNote) {
            NoteSheet(note: $note, canSave: !recordingTransition && !busy, onSave: addNote)
        }
        .sheet(isPresented: $showProjects) {
            ProjectPickerSheet(projects: projects, selectedId: meeting?.projectId, onSelect: assignProject)
        }
        .confirmationDialog(
            String(localized: "Delete this meeting from your iPhone?"), isPresented: $showDelete,
            titleVisibility: .visible
        ) {
            Button(String(localized: "Delete meeting"), role: .destructive, action: deleteMeeting)
        } message: {
            Text(
                String(
                    localized:
                        "The Mac copy is unaffected. Audio files for this meeting will also be deleted from your phone. Export any recordings you want to keep first."
                ))
        }
        .onAppear(perform: attachRecorder)
        .task(id: connectedIdentity) { await refreshRemote(automatic: true) }
        .confirmationDialog(
            String(localized: "Keep both versions?"), isPresented: $showSyncCopy, titleVisibility: .visible
        ) {
            Button(String(localized: "Upload as a new copy"), action: uploadSyncCopy)
        } message: {
            Text(
                String(
                    localized:
                        "This phone transcript will become a new meeting on your Mac. The existing Mac copy will be kept."
                ))
        }
        .onDisappear {
            recorder.cancelAutomaticResume()
            recorder.onResumeRequested = nil
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
                    baseDuration: baseDuration,
                    storedDuration: meeting.durationMs,
                    runActive: recordingRunActive,
                    locale: languageSelection,
                    audioFiles: meeting.audioFiles,
                    isStarting: starting,
                    canStart: !starting && !store.isReadOnly,
                    canChangeLanguage: !starting && !store.isReadOnly,
                    canExport: !recordingBusy,
                    onStart: { startRecording() },
                    onStop: stopRecording)
                if let message = error ?? store.syncErrors[meetingId]?.message { Notice(message: message) }
                if let recovery = recovery ?? store.syncErrors[meetingId]?.recovery {
                    switch recovery {
                    case "pair": Button(String(localized: "Pair Mac again")) { showConnection = true }
                    case "copy":
                        Button(String(localized: "Upload as a new copy")) { showSyncCopy = true }.disabled(
                            busy || recordingTransition)
                    case "project": Button(String(localized: "Choose another project"), action: loadProjects)
                    default:
                        Button(String(localized: "Sync meeting again"), action: syncMeeting).disabled(
                            busy || recordingTransition)
                    }
                }
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
                        SegmentOption(.transcript, String(localized: "Transcript · \(meeting.segments.count)")),
                        SegmentOption(
                            .assistant,
                            meeting.outputs.isEmpty
                                ? String(localized: "Assistant")
                                : String(localized: "Assistant · \(meeting.outputs.count)")),
                    ])
                switch tab {
                case .transcript:
                    TranscriptPanel(
                        segments: meeting.segments,
                        telemetry: recorder.telemetry,
                        isRecording: recorder.isRecording,
                        canAddNote: !recordingTransition && !busy && !store.isReadOnly,
                        onAddNote: { showNote = true })
                case .assistant:
                    AssistantPanel(
                        outputs: meeting.outputs,
                        outputErrors: store.outputErrors[meetingId] ?? [:],
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
                        onRefresh: refreshOutput,
                        onRefreshAll: { Task { await refreshRemote() } })
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 32)
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await refreshRemote() }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if recordingBusy {
                ToolbarItem(placement: .topBarLeading) {
                    Button(String(localized: "Back"), systemImage: "chevron.left") { showLeaveRecording = true }
                        .disabled(recorder.isStopping)
                }
            }
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
            Button(String(localized: "Add a text note"), systemImage: "square.and.pencil") { showNote = true }
                .disabled(recordingTransition || busy || store.isReadOnly)
            Button(String(localized: "Choose a Mac project"), systemImage: "folder", action: loadProjects)
                .disabled(recordingBusy || busy || store.isReadOnly)
            Button(String(localized: "Connect Mac"), systemImage: "desktopcomputer") { showConnection = true }
            if !meeting.segments.isEmpty {
                ShareLink(item: TranscriptExport(meeting: meeting), preview: SharePreview(meeting.title)) {
                    Label(String(localized: "Export transcript"), systemImage: "square.and.arrow.up")
                }
            }
            Divider()
            Button(String(localized: "Delete meeting from phone"), systemImage: "trash", role: .destructive) {
                showDelete = true
            }
            .disabled(recordingBusy || busy || store.isReadOnly)
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel(String(localized: "Meeting actions"))
    }

    // MARK: Recording

    private func attachRecorder() {
        store.resumePendingOutputs(connection: connection)
        locale = meeting?.recognitionLocale ?? meeting?.segments.last(where: { $0.lang != nil })?.lang ?? defaultLocale
        recorder.onStopped = { automaticallyResuming in finishRecording(automaticallyResuming: automaticallyResuming) }
        recorder.onResumeRequested = { startRecording(automatically: true) }
        recorder.onAudioSaved = { file, duration in
            store.update(meetingId) {
                if !$0.audioFiles.contains(file) { $0.audioFiles.append(file) }
                $0.durationMs = max($0.durationMs, baseDuration + duration)
            }
        }
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

    private func startRecording(automatically: Bool = false) {
        guard let meeting, !store.isReadOnly, !recordingBusy else { return }
        recorder.cancelAutomaticResume()
        error = nil
        baseDuration = meeting.durationMs
        starting = true
        recordingTask = Task {
            defer { starting = false }
            await recorder.start(locale: locale, automatically: automatically, title: meeting.title)
            guard recorder.isRecording else { return }
            if automatically { recorder.reportAutomaticResume() }
            recordingRunActive = true
            store.update(meetingId) {
                $0.status = "recording"
                $0.recognitionLocale = locale
            }
        }
    }

    private func stopRecording() {
        recorder.cancelAutomaticResume()
        recordingTask = Task {
            await recorder.stop()
            finishRecording()
        }
    }

    private func finishRecording(automaticallyResuming: Bool = false) {
        guard recordingRunActive else { return }
        recordingRunActive = false
        store.update(meetingId) {
            $0.status = "ended"
            $0.durationMs = max($0.durationMs, baseDuration + recorder.elapsedMs)
            if RecordingRunPolicy.keepAudio(durationMs: recorder.elapsedMs),
                let file = recorder.recordingURL?.lastPathComponent, !$0.audioFiles.contains(file)
            {
                $0.audioFiles.append(file)
            }
        }
        if RecordingRunPolicy.syncAfterStop(automaticallyResuming: automaticallyResuming),
            let meeting, meeting.remoteId != nil, meeting.syncedServer == connectedIdentity,
            let client = try? connection.client(), let identity = connectedIdentity
        {
            let precedingRequest = operation
            Task {
                await precedingRequest?.value
                guard let snapshot = store.meeting(meetingId), snapshot.status == "ended",
                    snapshot.syncedServer == identity
                else { return }
                // The store scopes failures to this meeting and serializes competing uploads.
                try? await store.syncMeeting(meetingId, client: client, identity: identity, finalOnly: true)
            }
        }
    }

    // MARK: Notes, projects and deletion

    private func addNote() {
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf16.count <= 15_990, !recordingTransition else { return }
        perform {
            let wasRecording = recordingRunActive
            let runOffset = baseDuration
            _ = await recorder.flush { offset in
                store.update(meetingId) {
                    let time = wasRecording ? runOffset + offset : $0.durationMs
                    $0.durationMs = max($0.durationMs, time)
                    $0.segments.append(
                        .init(tStart: time, tEnd: time, text: TranscriptSegment.notePrefix + text, lang: nil))
                }
            }
            note = ""
            showNote = false
        }
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
            _ = await recorder.flush()
            try await synchronize()
        }
    }

    private func synchronize() async throws {
        if recordingRunActive {
            store.update(meetingId) { $0.durationMs = max($0.durationMs, baseDuration + recorder.elapsedMs) }
        }
        guard let identity = connectedIdentity else { throw MeetingError.missingConnection }
        try await store.syncMeeting(meetingId, client: connection.client(), identity: identity)
        guard identity == connectedIdentity else { throw CancellationError() }
    }

    private func uploadSyncCopy() {
        guard !recordingTransition else { return }
        perform {
            try store.prepareSyncCopy(meetingId)
            _ = await recorder.flush()
            try await synchronize()
        }
    }

    private var languageSelection: Binding<String> {
        Binding(
            get: { locale },
            set: { value in
                locale = value
                defaultLocale = value
                store.update(meetingId, contentChanged: false) { $0.recognitionLocale = value }
            })
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
            _ = await recorder.flush()
            try Task.checkCancellation()
            try await synchronize()
            guard let meeting, !meeting.segments.isEmpty else { throw MeetingError.emptyTranscript }
            guard let remoteId = meeting.remoteId else { throw MeetingError.needsSync }
            let client = try connection.client()
            let identity = connectedIdentity
            let ticket: OutputTicket
            do {
                switch kind {
                case "catchup":
                    ticket = try await client.catchup(sessionId: remoteId, scope: scope)
                case "summary":
                    ticket = try await client.summary(sessionId: remoteId)
                default:
                    ticket = try await client.ask(sessionId: remoteId, question: prompt, projectContext: projectContext)
                }
            } catch {
                if case ConnectionError.server(_, "not_found", _) = error, let identity {
                    store.forgetRemote(meetingId, remoteId: remoteId, identity: identity)
                }
                throw error
            }
            try Task.checkCancellation()
            guard identity == connectedIdentity else { throw CancellationError() }
            let pending = AssistantOutput(
                id: ticket.id, kind: kind, status: "pending",
                question: kind == "answer" ? prompt : nil,
                scope: kind == "catchup" ? scope : nil)
            store.saveOutput(pending, meetingId: meetingId)
            if kind == "answer" { question = "" }
            if let identity = connectedIdentity {
                store.pollOutput(
                    ticket.id, meetingId: meetingId, client: client, identity: identity, reportingErrors: true)
            }
        }
    }

    private func refreshRemote(automatic: Bool = false) async {
        guard !store.isReadOnly, let meeting, let remoteId = meeting.remoteId,
            let identity = connectedIdentity, meeting.syncedServer == identity
        else { return }
        do {
            let detail = try await connection.client().detail(sessionId: remoteId)
            try Task.checkCancellation()
            guard connectedIdentity == identity, self.meeting?.remoteId == remoteId else { return }
            store.mergeRemoteOutputs(detail.outputs, meetingId: meetingId)
            error = nil
            recovery = nil
            store.resumePendingOutputs(connection: connection)
        } catch is CancellationError {
        } catch {
            guard !Task.isCancelled else { return }
            if case ConnectionError.server(_, "not_found", _) = error {
                store.forgetRemote(meetingId, remoteId: remoteId, identity: identity)
            }
            if RequestFeedback.shouldPresent(error, automatic: automatic) {
                self.error = error.localizedDescription
                recovery = (error as? ConnectionError)?.recovery
            }
        }
    }

    private func refreshOutput(_ id: String) {
        do {
            let client = try connection.client()
            if let identity = connectedIdentity {
                store.pollOutput(id, meetingId: meetingId, client: client, identity: identity, reportingErrors: true)
            }
        } catch { self.error = error.localizedDescription }
    }

    /// Runs one request to the Mac at a time and shows its error, unless it was cancelled.
    private func perform(_ work: @escaping @MainActor () async throws -> Void) {
        guard !store.isReadOnly, !busy else { return }
        error = nil
        recovery = nil
        busy = true
        operation = Task {
            defer { busy = false }
            do {
                try await work()
            } catch is CancellationError {
            } catch {
                if !Task.isCancelled {
                    self.error = error.localizedDescription
                    recovery = (error as? ConnectionError)?.recovery
                }
            }
        }
    }
}

/// SwiftUI's hidden Back button is supplemented by a gesture guard during capture.
private struct RecordingNavigationGuard: UIViewControllerRepresentable {
    let isLocked: Bool
    func makeUIViewController(context: Context) -> Controller { Controller() }
    func updateUIViewController(_ controller: Controller, context: Context) {
        controller.isLocked = isLocked
        controller.updateGesture()
    }
    static func dismantleUIViewController(_ controller: Controller, coordinator: ()) { controller.restore() }

    final class Controller: UIViewController {
        var isLocked = false
        private weak var gesture: UIGestureRecognizer?
        private var wasEnabled = true
        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            updateGesture()
        }
        func updateGesture() {
            guard isLocked else { restore(); return }
            guard let current = navigationController?.interactivePopGestureRecognizer else { return }
            if gesture !== current { restore(); gesture = current; wasEnabled = current.isEnabled }
            current.isEnabled = false
        }
        func restore() { gesture?.isEnabled = wasEnabled; gesture = nil }
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
                    Badge(text: String(localized: "Recording"), tone: .live)
                } else {
                    Badge(text: String(localized: "Saved on this iPhone"), tone: .muted, systemImage: "iphone")
                }
                if isSynced {
                    Badge(text: String(localized: "Synced to Mac"), tone: .ok, systemImage: "checkmark")
                } else if meeting.remoteId != nil {
                    Badge(
                        text: String(localized: "New content to sync"), tone: .warn,
                        systemImage: "arrow.triangle.2.circlepath")
                }
                if meeting.projectId != nil {
                    Badge(
                        text: projectName ?? String(localized: "Project linked"), tone: .accent, systemImage: "folder")
                }
            }
        }
        .padding(.horizontal, 4)
    }
}
