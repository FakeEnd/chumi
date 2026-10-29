import Combine
import Foundation

/// Meetings saved on this iPhone, persisted atomically as one JSON file.
@MainActor
final class MeetingStore: ObservableObject {
    @Published private(set) var meetings: [Meeting] = []
    @Published var errorMessage: String?
    @Published private(set) var isReadOnly = false
    let isDemo: Bool
    let fileURL: URL
    private let audioDirectory: URL
    @Published private(set) var recoveryURL: URL?
    private var pollingTasks: [String: (id: UUID, task: Task<Void, Never>)] = [:]
    private var pollingIdentity: String?
    private var syncing = Set<UUID>()
    @Published private(set) var outputErrors: [UUID: [String: String]] = [:]
    @Published private(set) var syncErrors: [UUID: RequestIssue] = [:]

    init(
        demo: Bool = ProcessInfo.processInfo.arguments.contains("--demo"), directory: URL? = nil,
        audioDirectory: URL = RecordingStorage.directory
    ) {
        isDemo = demo
        self.audioDirectory = audioDirectory
        let root =
            directory
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Chumi", isDirectory: true)
        fileURL = root.appendingPathComponent("meetings.json")
        if demo {
            meetings = Meeting.demoMeetings()
            isReadOnly = true
            return
        }
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
            let data = try Data(contentsOf: fileURL)
            let entries = (try? JSONSerialization.jsonObject(with: data)) as? [Any]
            var loaded: [Meeting] = []
            var seen = Set<UUID>()
            for entry in entries ?? [] {
                do {
                    let item = try JSONDecoder().decode(
                        Meeting.self, from: JSONSerialization.data(withJSONObject: entry, options: .fragmentsAllowed))
                    try item.validate()
                    guard seen.insert(item.id).inserted else { throw MeetingError.invalidFile }
                    loaded.append(item)
                } catch { continue }
            }
            let needsRecovery = entries == nil || loaded.count != entries?.count
            if needsRecovery {
                // Preserve the complete original before replacing even one unreadable entry.
                let recoveryDirectory =
                    (directory ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0])
                    .appendingPathComponent("Chumi Recovery", isDirectory: true)
                try FileManager.default.createDirectory(at: recoveryDirectory, withIntermediateDirectories: true)
                let backup = recoveryDirectory.appendingPathComponent(
                    "meetings-\(Int(Date().timeIntervalSince1970))-\(UUID().uuidString).json")
                try data.write(to: backup, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                recoveryURL = backup
                errorMessage = String(
                    localized:
                        "Some meetings could not be read. The original data is saved in Chumi Recovery in Files. You can keep using the other meetings."
                )
            }
            // An OS-terminated recording is a recoverable, ended local meeting.
            meetings = loaded.map { original in
                var item = original
                if item.status != "ended" {
                    item.status = "ended"
                    item.revision += 1
                }
                return item
            }
            .sorted { $0.startedAt > $1.startedAt }
            let recoveryMessage = errorMessage
            if needsRecovery || meetings != loaded { try persist() }
            if needsRecovery { errorMessage = recoveryMessage }
        } catch {
            errorMessage = String(localized: "Could not load meetings: \(error.localizedDescription)")
            isReadOnly = true
        }
    }

    func meeting(_ id: UUID) -> Meeting? { meetings.first { $0.id == id } }

    @discardableResult
    func create(title: String, type: String) throws -> UUID {
        guard !isReadOnly else { throw MeetingError.invalidFile }
        let item = Meeting(title: title.trimmingCharacters(in: .whitespacesAndNewlines), type: type)
        try item.validate()
        let previous = meetings
        meetings.insert(item, at: 0)
        do {
            try persist()
        } catch {
            meetings = previous
            throw error
        }
        return item.id
    }

    /// Applies `body` and saves. Content changes bump the revision, so the Mac copy is known to be stale.
    func update(_ id: UUID, contentChanged: Bool = true, _ body: (inout Meeting) -> Void) {
        guard !isReadOnly, let index = meetings.firstIndex(where: { $0.id == id }) else { return }
        let previous = meetings[index]
        body(&meetings[index])
        guard meetings[index] != previous else { return }
        if contentChanged { meetings[index].revision += 1 }
        do {
            try meetings[index].validate()
        } catch {
            meetings[index] = previous
            errorMessage = String(localized: "Could not save this content: \(error.localizedDescription)")
            return
        }
        do {
            try persist()
        } catch {
            errorMessage = String(
                localized: "Saving failed. Your current content is still in memory: \(error.localizedDescription)")
        }
    }

    /// Persist the replacement identity before any request can create a new Mac copy.
    func prepareSyncCopy(_ id: UUID) throws {
        guard !isReadOnly, let index = meetings.firstIndex(where: { $0.id == id }) else {
            throw MeetingError.unavailable
        }
        let previous = meetings[index]
        meetings[index].syncClientId = UUID()
        meetings[index].remoteId = nil
        meetings[index].syncedRevision = nil
        meetings[index].syncedServer = nil
        do { try persist() } catch { meetings[index] = previous; throw error }
        syncErrors[id] = nil
    }

    func recordSync(_ id: UUID, response: SyncResponse, sent: Meeting, identity: String) throws {
        guard let current = meeting(id),
            var accepted = try SyncRecovery.reconcile(response, sent: sent, current: current)
        else { throw CancellationError() }
        accepted.syncedServer = identity
        update(id, contentChanged: false) { $0 = accepted }
        syncErrors[id] = nil
    }

    /// Serialize uploads so a stop, a manual sync and an AI action share revision accounting.
    func syncMeeting(_ id: UUID, client: MobileAPI, identity: String, finalOnly: Bool = false) async throws {
        while syncing.contains(id) { try await Task.sleep(nanoseconds: 50_000_000) }
        try Task.checkCancellation()
        guard !isReadOnly, let snapshot = meeting(id) else { throw MeetingError.unavailable }
        if finalOnly && (snapshot.status != "ended" || snapshot.syncedServer != identity) { return }
        syncing.insert(id)
        defer { syncing.remove(id) }
        do {
            let response = try await client.sync(snapshot)
            try Task.checkCancellation()
            try recordSync(id, response: response, sent: snapshot, identity: identity)
        } catch is CancellationError { throw CancellationError() } catch {
            if meeting(id)?.syncClientId == snapshot.syncClientId { syncErrors[id] = RequestIssue(error) }
            throw error
        }
    }

    func saveOutput(_ output: AssistantOutput, meetingId: UUID) {
        guard let current = meeting(meetingId) else { return }
        outputErrors[meetingId]?[output.id] = nil
        if output.kind == "digest" || output.status == "suppressed" {
            guard current.outputs.contains(where: { $0.id == output.id }) else { return }
            update(meetingId, contentChanged: false) { $0.outputs.removeAll { $0.id == output.id } }
            return
        }
        var merged = output
        if let previous = current.outputs.first(where: { $0.id == output.id }) {
            // The Mac does not echo phone-only fields.
            merged.scope = output.scope ?? previous.scope
            guard merged != previous else { return }
        }
        update(meetingId, contentChanged: false) { meeting in
            if let index = meeting.outputs.firstIndex(where: { $0.id == output.id }) {
                meeting.outputs[index] = merged
            } else {
                meeting.outputs.insert(merged, at: 0)
            }
        }
    }

    func mergeRemoteOutputs(_ outputs: [AssistantOutput], meetingId: UUID) {
        for output in outputs { outputErrors[meetingId]?[output.id] = nil }
        update(meetingId, contentChanged: false) { meeting in
            for output in outputs {
                let previous = meeting.outputs.first { $0.id == output.id }
                meeting.outputs.removeAll { $0.id == output.id }
                guard output.kind != "digest", output.status != "suppressed" else { continue }
                var merged = output
                merged.scope = output.scope ?? previous?.scope
                meeting.outputs.append(merged)
            }
            meeting.outputs.sort {
                ($0.createdAt ?? .greatestFiniteMagnitude) > ($1.createdAt ?? .greatestFiniteMagnitude)
            }
        }
    }

    func forgetRemote(_ meetingId: UUID, remoteId: String, identity: String) {
        guard let item = meeting(meetingId), item.remoteId == remoteId, item.syncedServer == identity else { return }
        outputErrors[meetingId] = nil
        syncErrors[meetingId] = nil
        update(meetingId, contentChanged: false) {
            $0.remoteId = nil
            $0.syncedRevision = nil
            $0.syncedServer = nil
            for index in $0.outputs.indices where !$0.outputs[index].isFinished {
                $0.outputs[index].status = "cancelled"
                $0.outputs[index].error = ConnectionError.server(404, "not_found").localizedDescription
            }
        }
    }

    func resumePendingOutputs(connection: ConnectionStore) {
        let identity = connection.identity
        if pollingIdentity != identity {
            pollingTasks.values.forEach { $0.task.cancel() }
            pollingTasks.removeAll()
            pollingIdentity = identity
        }
        guard !isReadOnly, let identity, let client = try? connection.client() else { return }
        for meeting in meetings where meeting.syncedServer == identity {
            for output in meeting.outputs where !output.isFinished {
                pollOutput(output.id, meetingId: meeting.id, client: client, identity: identity)
            }
        }
    }

    func pollOutput(_ id: String, meetingId: UUID, client: MobileAPI, identity: String, reportingErrors: Bool = false) {
        let key = identity + "|" + meetingId.uuidString + "|" + id
        guard !isReadOnly, pollingTasks[key] == nil else { return }
        let token = UUID()
        let task = Task { [weak self] in
            defer {
                if self?.pollingTasks[key]?.id == token { self?.pollingTasks.removeValue(forKey: key) }
            }
            do {
                let deadline = Date().addingTimeInterval(180)
                var delay: UInt64 = 1_200_000_000
                while Date() < deadline {
                    try Task.checkCancellation()
                    let output = try await client.output(id: id)
                    try Task.checkCancellation()
                    guard let self, self.meeting(meetingId)?.syncedServer == identity else { return }
                    self.saveOutput(output, meetingId: meetingId)
                    if output.isFinished { return }
                    try await Task.sleep(nanoseconds: delay)
                    delay = min(delay * 2, 10_000_000_000)
                }
                throw MeetingError.pollingTimeout
            } catch is CancellationError {
            } catch {
                if !Task.isCancelled, reportingErrors, let self, self.meeting(meetingId)?.syncedServer == identity {
                    self.outputErrors[meetingId, default: [:]][id] = error.localizedDescription
                }
            }
        }
        pollingTasks[key] = (token, task)
    }

    func remove(_ id: UUID) throws {
        guard !isReadOnly else { return }
        guard let item = meeting(id), item.status != "recording" else { return }
        let previous = meetings
        meetings.removeAll { $0.id == id }
        do {
            try persist()
        } catch {
            meetings = previous
            throw error
        }
        outputErrors[id] = nil
        syncErrors[id] = nil
        for name in item.audioFiles where !meetings.contains(where: { $0.audioFiles.contains(name) }) {
            let url = audioDirectory.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            do { try FileManager.default.removeItem(at: url) } catch {
                errorMessage = String(
                    localized:
                        "The meeting was deleted, but some audio files could not be removed. Remove them from Chumi / Recordings in Files."
                )
            }
        }
    }

    private func persist() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(meetings)
        try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        errorMessage = nil
    }
}

/// Leave room for the transcript and other app data when audio approaches a full disk.
enum RecordingStorage {
    static let reserveBytes: Int64 = 64 * 1024 * 1024
    static var directory: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(
            "Recordings", isDirectory: true)
    }
    static func availableBytes(at directory: URL) async throws -> Int64 {
        try await Task.detached(priority: .utility) { try readAvailableBytes(at: directory) }.value
    }
    private static func readAvailableBytes(at directory: URL) throws -> Int64 {
        let values = try directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        if let capacity = values.volumeAvailableCapacityForImportantUsage { return capacity }
        let attributes = try FileManager.default.attributesOfFileSystem(forPath: directory.path)
        return (attributes[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
    }
    static func minutesRemaining(capacity: Int64, bytesPerSecond: Double) -> Int {
        guard bytesPerSecond.isFinite, bytesPerSecond > 0 else { return 0 }
        return Int(max(0, Double(capacity - reserveBytes)) / bytesPerSecond / 60)
    }
    static func filename(title: String, date: Date = Date(), id: UUID = UUID()) -> String {
        let dateFormat = DateFormatter()
        dateFormat.locale = Locale(identifier: "en_US_POSIX")
        dateFormat.dateFormat = "yyyy-MM-dd HHmm"
        let clean = String(
            title.unicodeScalars.filter {
                !CharacterSet.controlCharacters.contains($0) && !"/\\:".unicodeScalars.contains($0)
            }.prefix(60)
        )
        .trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(dateFormat.string(from: date)) \(clean) \(id.uuidString.prefix(8)).caf"
    }
}
