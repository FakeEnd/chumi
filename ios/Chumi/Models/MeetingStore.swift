import Combine
import Foundation

/// Meetings saved on this iPhone, persisted atomically as one JSON file.
@MainActor
final class MeetingStore: ObservableObject {
    @Published private(set) var meetings: [Meeting] = []
    @Published var errorMessage: String?
    @Published private(set) var isReadOnly = false
    let isDemo: Bool
    private let fileURL: URL

    init(demo: Bool = ProcessInfo.processInfo.arguments.contains("--demo"), directory: URL? = nil) {
        isDemo = demo
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
            let loaded = try JSONDecoder().decode([Meeting].self, from: Data(contentsOf: fileURL))
            guard Set(loaded.map(\.id)).count == loaded.count else { throw MeetingError.invalidFile }
            try loaded.forEach { try $0.validate() }
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
            if meetings != loaded { try persist() }
        } catch {
            errorMessage = "无法载入会议：\(error.localizedDescription)"
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
        if contentChanged { meetings[index].revision += 1 }
        do {
            try meetings[index].validate()
        } catch {
            meetings[index] = previous
            errorMessage = "内容无法保存：\(error.localizedDescription)"
            return
        }
        do {
            try persist()
        } catch {
            errorMessage = "保存失败，当前内容仍在内存中：\(error.localizedDescription)"
        }
    }

    func saveOutput(_ output: AssistantOutput, meetingId: UUID) {
        update(meetingId, contentChanged: false) { meeting in
            guard let index = meeting.outputs.firstIndex(where: { $0.id == output.id }) else {
                meeting.outputs.insert(output, at: 0)
                return
            }
            var merged = output
            // The Mac does not echo phone-only fields.
            merged.scope = output.scope ?? meeting.outputs[index].scope
            meeting.outputs[index] = merged
        }
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
        // Audio is retained deliberately: the user can export it through Files before cleanup.
    }

    private func persist() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(meetings)
        try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
