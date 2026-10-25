import Foundation

@main
struct CoreChecks {
    @MainActor
    static func main() throws {
        func rejects(_ block: () throws -> Void) {
            do { try block(); fatalError("Expected validation to reject input") } catch {}
        }
        let endpoint = try MobileEndpoint("https://My-Mac.local:4778/mobile/v1/")
        let askURL = try endpoint.url("sessions/s_abc-123/ask")
        precondition(askURL.absoluteString == "https://my-mac.local:4778/mobile/v1/sessions/s_abc-123/ask")
        for raw in [
            "http://192.168.1.2:4778", "https://user:secret@mac.local", "https://mac.local?token=x",
            "https://mac.local/#secret", "https://mac.local/unexpected", "file:///tmp/mac", "https://mac.local:70000",
        ] {
            rejects { _ = try MobileEndpoint(raw, allowSimulatorHTTP: true) }
        }
        rejects { _ = try MobileEndpoint("http://localhost:4778") }
        _ = try MobileEndpoint("http://localhost:4778", allowSimulatorHTTP: true)
        _ = try MobileEndpoint("http://127.0.0.1:4778", allowSimulatorHTTP: true)
        _ = try MobileEndpoint("http://[::1]:4778", allowSimulatorHTTP: true)
        for path in [
            "../health", "/health", "sessions//ask", "sessions/a?x=1", "sessions/a%2Fb", "sessions/a#fragment",
        ] {
            rejects { _ = try endpoint.url(path) }
        }
        let token = String(repeating: "a", count: 64)
        let pin = String(repeating: "AB:", count: 31) + "AB"
        let pairing = try PairingCredentials(url: "https://mac.local:4778", token: token, certificateSHA256: pin)
            .validated()
        precondition(pairing.certificateSHA256 == String(repeating: "ab", count: 32))
        rejects {
            _ = try PairingCredentials(url: "https://mac.local", token: "short", certificateSHA256: nil).validated()
        }
        rejects {
            _ = try PairingCredentials(url: "https://mac.local", token: token, certificateSHA256: "invalid").validated()
        }
        let output = try JSONDecoder().decode(
            OutputResponse.self,
            from: Data(
                #"{"output":{"id":"o_1","sessionId":"m_1","kind":"final_summary","status":"done","question":null,"text":"内容","error":null,"createdAt":123,"completedAt":456,"provider":"codex","model":"configured"}}"#
                    .utf8))
        precondition(output.output.content == "内容" && output.output.isFinished)
        precondition(output.output.label == "总结" && output.output.title == "最终总结" && output.output.scope == nil)
        let catchup = AssistantOutput(id: "o_2", kind: "catchup", status: "pending", scope: "5m")
        precondition(catchup.title == "回顾 · 最近 5 分钟" && !catchup.isFinished)
        precondition(
            TranscriptSegment(tStart: 0, tEnd: 0, text: TranscriptSegment.notePrefix + "笔记").displayText == "笔记")
        let sync = try JSONDecoder().decode(
            SyncResponse.self,
            from: Data(#"{"sessionId":"m_1","clientId":"test","revision":2,"status":"accepted"}"#.utf8))
        precondition(sync.id == "m_1" && sync.revision == 2)
        let ticket = try JSONDecoder().decode(OutputTicket.self, from: Data(#"{"outputId":"o_1"}"#.utf8))
        precondition(ticket.id == "o_1")

        var meeting = Meeting(title: "测试会议", durationMs: 1200)
        meeting.segments = [.init(tStart: 0, tEnd: 1200, text: "中英 mixed", lang: "zh-CN")]
        try meeting.validate()
        let roundTrip = try JSONDecoder().decode(Meeting.self, from: JSONEncoder().encode(meeting))
        precondition(roundTrip == meeting)
        meeting.segments[0].tEnd = 1201
        rejects { try meeting.validate() }
        meeting.segments[0].tEnd = 1200
        meeting.audioFiles = ["../escaped.caf"]
        rejects { try meeting.validate() }

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "chumi-ios-tests-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = MeetingStore(demo: false, directory: directory)
        let id = try store.create(title: "本地会议", type: "lab_meeting")
        store.update(id) {
            $0.durationMs = 2500; $0.segments = [.init(tStart: 0, tEnd: 2500, text: "保留记录", lang: nil)];
            $0.status = "recording"
        }
        store.saveOutput(catchup, meetingId: id)
        var finished = catchup
        finished.status = "done"
        finished.scope = nil  // the Mac does not echo the scope
        store.saveOutput(finished, meetingId: id)
        precondition(store.meeting(id)?.outputs.first?.scope == "5m" && store.meeting(id)?.outputs.count == 1)
        let recovered = MeetingStore(demo: false, directory: directory)
        precondition(recovered.meeting(id)?.status == "ended")
        precondition(recovered.meeting(id)?.segments.first?.text == "保留记录")
        let file = directory.appendingPathComponent("meetings.json")
        let malformed = Data("corrupt file retained".utf8)
        try malformed.write(to: file)
        let damaged = MeetingStore(demo: false, directory: directory)
        precondition(damaged.isReadOnly && damaged.errorMessage != nil)
        precondition((try? Data(contentsOf: file)) == malformed)
        let demo = MeetingStore(demo: true, directory: directory)
        precondition(demo.isReadOnly && demo.meetings.count == Meeting.demoMeetings().count)
        try demo.meetings.forEach { try $0.validate() }
        precondition((try? Data(contentsOf: file)) == malformed)
        print(
            "PASS: endpoint security, pairing validation, backend DTO decoding, output labels and scope merge, meeting validation, atomic persistence/recovery, corruption protection, inert demo"
        )
    }
}
