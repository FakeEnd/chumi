import Foundation

@main
struct CoreChecks {
    @MainActor
    static func main() async throws {
        func rejects(_ block: () throws -> Void) {
            do { try block(); fatalError("Expected validation to reject input") } catch {}
        }
        let localizationRoot = URL(fileURLWithPath: CommandLine.arguments[1])
        let english = Bundle(url: localizationRoot.appendingPathComponent("en.lproj"))!
        let chinese = Bundle(url: localizationRoot.appendingPathComponent("zh-Hans.lproj"))!
        precondition(String(localized: "Start recording", bundle: english) == "Start recording")
        precondition(String(localized: "Start recording", bundle: chinese) == "开始录音")
        let minutes = 12
        let storageWarning = String(
            localized:
                "Storage is low: about \(minutes) minutes of recording remain. Export and delete older recordings soon.",
            bundle: chinese)
        precondition(storageWarning.contains("12 分钟"))
        precondition(
            chinese.localizedString(forKey: "NSMicrophoneUsageDescription", value: nil, table: "InfoPlist").contains(
                "麦克风"))

        let failure = try JSONDecoder().decode(
            MobileFailure.self, from: Data(#"{"error":"English server message","code":"not_found"}"#.utf8))
        precondition(failure.code == "not_found")
        precondition(ConnectionError.certificateChanged.recovery == "pair")
        precondition(ConnectionError.server(401, nil).recovery == "pair")
        precondition(ConnectionError.server(409, "invalid_project").recovery == "project")
        precondition(ConnectionError.server(404, "not_found").recovery == "sync")
        precondition(!ConnectionError.server(500, nil).localizedDescription.contains("English server message"))
        precondition(ConnectionError.transport(.cannotConnectToHost).localizedDescription.contains("Wi-Fi"))
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
        precondition(
            output.output.label == "Summary" && output.output.title == "Final summary" && output.output.scope == nil)
        let catchup = AssistantOutput(id: "o_2", kind: "catchup", status: "pending", scope: "5m")
        precondition(catchup.title == "Catch-up · Last 5 minutes" && !catchup.isFinished)
        precondition(
            TranscriptSegment(tStart: 0, tEnd: 0, text: TranscriptSegment.notePrefix + "笔记").displayText == "笔记")
        let sync = try JSONDecoder().decode(
            SyncResponse.self,
            from: Data(#"{"sessionId":"m_1","clientId":"test","revision":2,"status":"accepted"}"#.utf8))
        precondition(sync.id == "m_1" && sync.revision == 2)
        let ticket = try JSONDecoder().decode(OutputTicket.self, from: Data(#"{"outputId":"o_1"}"#.utf8))
        precondition(ticket.id == "o_1")

        var meeting = Meeting(title: "测试会议", durationMs: 1200)
        meeting.recognitionLocale = "en-US"
        meeting.segments = [.init(tStart: 0, tEnd: 1200, text: "中英 mixed", lang: "zh-CN")]
        try meeting.validate()
        let roundTrip = try JSONDecoder().decode(Meeting.self, from: JSONEncoder().encode(meeting))
        precondition(roundTrip == meeting)
        meeting.segments[0].tEnd = 1201
        rejects { try meeting.validate() }
        meeting.segments[0].tEnd = 1200
        for invalidName in ["../escaped.caf", ".", "", ".."] {
            meeting.audioFiles = [invalidName]
            rejects { try meeting.validate() }
        }

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "chumi-ios-tests-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let audioDirectory = directory.appendingPathComponent("Recordings")
        try FileManager.default.createDirectory(at: audioDirectory, withIntermediateDirectories: true)
        precondition(
            RecordingStorage.minutesRemaining(capacity: RecordingStorage.reserveBytes, bytesPerSecond: 192_000) == 0)
        precondition(
            RecordingStorage.minutesRemaining(
                capacity: RecordingStorage.reserveBytes + 192_000 * 60 * 30, bytesPerSecond: 192_000) == 30)
        let filename = RecordingStorage.filename(title: "a/b:c\\d\n")
        precondition(filename.hasSuffix(".caf") && !filename.contains("/") && !filename.contains(":"))
        let store = MeetingStore(demo: false, directory: directory, audioDirectory: audioDirectory)
        let deleted = try store.create(title: "Delete audio", type: "other")
        let audio = audioDirectory.appendingPathComponent("recording.caf")
        try Data("audio".utf8).write(to: audio)
        store.update(deleted) { $0.audioFiles = [audio.lastPathComponent] }
        try store.remove(deleted)
        precondition(store.meeting(deleted) == nil && !FileManager.default.fileExists(atPath: audio.path))
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
        let persisted = directory.appendingPathComponent("meetings.json")
        let oldDate = Date(timeIntervalSince1970: 1000)
        try FileManager.default.setAttributes([.modificationDate: oldDate], ofItemAtPath: persisted.path)
        store.saveOutput(finished, meetingId: id)
        let unchangedDate = try FileManager.default.attributesOfItem(atPath: persisted.path)[.modificationDate] as? Date
        precondition(unchangedDate == oldDate, "Unchanged polling results must not rewrite the store")
        precondition(store.meeting(id)?.outputs.first?.scope == "5m" && store.meeting(id)?.outputs.count == 1)
        let remote = try JSONDecoder().decode(
            MobileSessionDetail.self,
            from: Data(
                #"{"outputs":[{"id":"mac-summary","kind":"final_summary","status":"done","text":"From Mac","createdAt":2000},{"id":"hidden","kind":"digest","status":"done"},{"id":"suppressed","kind":"answer","status":"suppressed"}]}"#
                    .utf8))
        store.mergeRemoteOutputs(remote.outputs, meetingId: id)
        precondition(store.meeting(id)?.outputs.count == 2)
        precondition(store.meeting(id)?.outputs.contains(where: { $0.id == "mac-summary" }) == true)
        store.update(id, contentChanged: false) {
            $0.remoteId = "old"; $0.syncedServer = "mac"; $0.syncedRevision = $0.revision
        }
        store.forgetRemote(id, remoteId: "different", identity: "mac")
        precondition(store.meeting(id)?.isSynced == true)
        store.forgetRemote(id, remoteId: "old", identity: "mac")
        precondition(store.meeting(id)?.remoteId == nil && store.meeting(id)?.syncedRevision == nil)
        let recovered = MeetingStore(demo: false, directory: directory)
        precondition(recovered.meeting(id)?.status == "ended")
        precondition(recovered.meeting(id)?.segments.first?.text == "保留记录")
        let file = directory.appendingPathComponent("meetings.json")
        let malformed = Data("corrupt file retained".utf8)
        try malformed.write(to: file)
        let damaged = MeetingStore(demo: false, directory: directory)
        precondition(!damaged.isReadOnly && damaged.errorMessage != nil && damaged.meetings.isEmpty)
        precondition((try? Data(contentsOf: damaged.recoveryURL!)) == malformed)
        _ = try damaged.create(title: "Recovered store is writable", type: "other")
        let legacy = Data("[{\"id\":\"\(id.uuidString)\",\"title\":\"Legacy\",\"startedAt\":1000},{\"bad\":true}]".utf8)
        try legacy.write(to: file)
        let partial = MeetingStore(demo: false, directory: directory)
        precondition(!partial.isReadOnly && partial.meetings.count == 1)
        precondition(
            partial.meeting(id)?.recognitionLocale == nil && partial.meeting(id)?.revision == 1
                && partial.meeting(id)?.audioFiles == [])
        precondition((try? Data(contentsOf: partial.recoveryURL!)) == legacy)
        let recoveredData = try Data(contentsOf: file)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubMobileProtocol.self]
        let api = try MobileAPI(credentials: pairing, configuration: configuration)
        let detail = try await api.detail(sessionId: "session")
        precondition(detail.outputs.first?.content == "Mac summary")
        do {
            _ = try await api.detail(sessionId: "deleted")
            fatalError("Missing session must fail")
        } catch ConnectionError.server(let status, let code, _) {
            precondition(status == 404 && code == "not_found")
        }
        let pollStore = MeetingStore(demo: false, directory: directory.appendingPathComponent("poll"))
        let polledId = try pollStore.create(title: "Pending answer", type: "other")
        pollStore.update(polledId, contentChanged: false) {
            $0.syncedServer = "mac"; $0.remoteId = "session"
        }
        pollStore.saveOutput(.init(id: "pending", kind: "answer", status: "pending", scope: "5m"), meetingId: polledId)
        pollStore.pollOutput("pending", meetingId: polledId, client: api, identity: "mac")
        pollStore.pollOutput("pending", meetingId: polledId, client: api, identity: "mac")
        try await Task.sleep(nanoseconds: 100_000_000)
        pollStore.update(polledId) { $0.status = "recording" }
        precondition(pollStore.meeting(polledId)?.status == "recording")
        let pollDeadline = Date().addingTimeInterval(4)
        while pollStore.meeting(polledId)?.outputs.first?.isFinished == false && Date() < pollDeadline {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        precondition(pollStore.meeting(polledId)?.outputs.first?.content == "Finished answer")
        precondition(pollStore.meeting(polledId)?.outputs.first?.scope == "5m")
        precondition(StubMobileProtocol.pollCount == 2, "Duplicate polling must share the running task")
        try await checkRecovery(directory: directory, pairing: pairing)
        let demo = MeetingStore(demo: true, directory: directory)
        precondition(demo.isReadOnly && demo.meetings.count == Meeting.demoMeetings().count)
        try demo.meetings.forEach { try $0.validate() }
        precondition((try? Data(contentsOf: file)) == recoveredData)
        print(
            "PASS: endpoint security, pairing validation, backend DTO decoding, output labels and scope merge, meeting validation, atomic persistence/recovery, corruption protection, inert demo"
        )
    }

    @MainActor
    static func checkRecovery(directory: URL, pairing: PairingCredentials) async throws {
        var recovery = RecordingRecovery()
        recovery.request(at: 10, awaitingInterruptionEnd: true)
        recovery.request(at: 11)
        precondition(recovery.requestedAt == 10 && !recovery.allowed)
        precondition(!recovery.takeResume(at: 11, active: true))
        recovery.interruptionEnded(shouldResume: true)
        precondition(!recovery.takeResume(at: 12, active: false))
        precondition(recovery.takeResume(at: 20, active: true))
        precondition(!recovery.takeResume(at: 21, active: true), "A recovery is consumed once")
        recovery.request(at: 30)
        precondition(recovery.takeResume(at: 31, active: true))
        recovery.request(at: 40)
        precondition(!recovery.takeResume(at: 41, active: true), "Repeated failed starts are bounded")
        recovery.markHealthy()
        recovery.request(at: 50)
        precondition(recovery.takeResume(at: 51, active: true))
        recovery.request(at: 60, awaitingInterruptionEnd: true)
        recovery.interruptionEnded(shouldResume: true)
        precondition(!recovery.takeResume(at: 181, active: true))
        precondition(recovery.requestedAt == nil, "An old call must never restart the mic on foreground")
        recovery.request(at: 200)
        recovery.interruptionEnded(shouldResume: false)
        precondition(!recovery.takeResume(at: 201, active: true))
        recovery.request(at: 300)
        recovery.cancel()
        precondition(!recovery.takeResume(at: 301, active: true))
        recovery.request(at: 400)
        precondition(!recovery.takeResume(at: 399, active: true))
        recovery.reset()
        precondition(recovery.attempts == 0 && recovery.requestedAt == nil)
        precondition(RecordingRunPolicy.preferBuiltIn(over: [.headset]))
        for inputs: [RecordingInputKind] in [[.builtIn], [.external], [.headset, .external], []] {
            precondition(!RecordingRunPolicy.preferBuiltIn(over: inputs))
        }
        precondition(!RecordingRunPolicy.keepAudio(durationMs: 0))
        precondition(RecordingRunPolicy.keepAudio(durationMs: 100))
        precondition(!RecordingRunPolicy.syncAfterStop(automaticallyResuming: true))
        precondition(RecordingRunPolicy.syncAfterStop(automaticallyResuming: false))

        let offline = ConnectionError.transport(.cannotConnectToHost)
        precondition(!RequestFeedback.shouldPresent(offline, automatic: true))
        precondition(RequestFeedback.shouldPresent(offline, automatic: false))
        precondition(!RequestFeedback.shouldPresent(MeetingError.pollingTimeout, automatic: true))
        precondition(RequestFeedback.shouldPresent(ConnectionError.certificateChanged, automatic: true))
        precondition(RequestFeedback.shouldPresent(ConnectionError.server(404, "not_found"), automatic: true))
        for code in ["session_conflict", "revision_conflict", "segment_conflict"] {
            let error = ConnectionError.server(409, code, revision: 8)
            precondition(error.recovery == "copy" && error.localizedDescription.contains("new copy"))
            precondition(SyncRecovery.retryRevision(for: error, sentRevision: 2, retries: 0) == nil)
        }
        precondition(ConnectionError.server(400, "invalid_request").localizedDescription.contains("backup"))
        precondition(ConnectionError.server(413, "body_too_large").localizedDescription.contains("4 MiB"))
        for revision: Int? in [nil, 1, SyncRecovery.maximumRevision, Int.max] {
            precondition(
                SyncRecovery.retryRevision(
                    for: .server(409, "stale_revision", revision: revision), sentRevision: 2, retries: 0) == nil)
        }
        precondition(
            SyncRecovery.retryRevision(for: .server(409, "stale_revision", revision: 8), sentRevision: 2, retries: 1)
                == nil)

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RecoveryProtocol.self]
        let api = try MobileAPI(credentials: pairing, configuration: configuration)
        let root = directory.appendingPathComponent("sync-recovery")
        let store = MeetingStore(demo: false, directory: root)
        let id = try store.create(title: "Original", type: "lab_meeting")
        store.update(id) {
            $0.durationMs = 100; $0.segments = [.init(tStart: 0, tEnd: 100, text: "Original")]
        }
        let sent = store.meeting(id)!
        RecoveryProtocol.setReplies([
            .http(409, #"{"error":"Newer copy","code":"stale_revision","revision":8,"details":{"revision":100}}"#),
            .http(200, #"{"sessionId":"remote","revision":9}"#),
        ])
        let response = try await api.sync(sent)
        let requests = RecoveryProtocol.bodies
        precondition(requests.count == 2 && requests[1]["revision"] as? Int == 9, "Use the top-level revision")
        var first = requests[0]; first["revision"] = 9
        precondition(NSDictionary(dictionary: first).isEqual(to: requests[1]), "Retry preserves every payload field")
        store.update(id) { $0.title = "Edited during upload" }
        try store.recordSync(id, response: response, sent: sent, identity: "mac")
        precondition(store.meeting(id)?.revision == 10 && store.meeting(id)?.syncedRevision == 9)
        precondition(store.meeting(id)?.isSynced == false && store.meeting(id)?.title == "Edited during upload")

        let metadata = SyncMetadata(title: "Mac title", type: "other", projectId: "mac-project")
        let beforeMetadata = store.meeting(id)!
        let canonical = try SyncRecovery.reconcile(
            .init(sessionId: "remote", revision: 10, metadata: metadata), sent: beforeMetadata, current: beforeMetadata)!
        precondition(
            canonical.title == "Mac title" && canonical.type == "other" && canonical.projectId == "mac-project")
        precondition(
            canonical.revision == 11 && canonical.syncedRevision == 10,
            "Changed canonical metadata needs a fresh request revision")
        let longTitle = String(repeating: "M", count: 300)
        let longMetadata = SyncMetadata(title: longTitle, type: "other", projectId: nil)
        let longCanonical = try SyncRecovery.reconcile(
            .init(sessionId: "remote", revision: 10, metadata: longMetadata), sent: beforeMetadata,
            current: beforeMetadata)
        precondition(longCanonical?.title == longTitle, "Accept titles up to the mobile server limit")
        var concurrent = beforeMetadata
        concurrent.revision += 1; concurrent.title = "Phone edit"; concurrent.projectId = "phone-project"
        let merged = try SyncRecovery.reconcile(
            .init(sessionId: "remote", revision: 10, metadata: metadata), sent: beforeMetadata, current: concurrent)!
        precondition(merged.title == "Phone edit" && merged.projectId == "phone-project" && merged.type == "other")

        RecoveryProtocol.setReplies([
            .http(409, #"{"code":"stale_revision","revision":20}"#),
            .http(409, #"{"code":"stale_revision","revision":21}"#),
        ])
        do {
            try await store.syncMeeting(id, client: api, identity: "mac"); fatalError("Expected bounded conflict")
        } catch ConnectionError.server(_, "stale_revision", _) {}
        precondition(RecoveryProtocol.bodies.count == 2)
        precondition(store.syncErrors[id]?.recovery == "copy" && store.errorMessage == nil)

        // The final-stop path uses the same accounting and metadata merge as manual sync.
        RecoveryProtocol.setReplies([
            .http(409, #"{"code":"stale_revision","revision":21}"#),
            .http(
                200,
                #"{"sessionId":"remote","revision":22,"metadata":{"title":"Mac edited","type":"other","projectId":null}}"#
            ),
        ])
        try await store.syncMeeting(id, client: api, identity: "mac", finalOnly: true)
        precondition(store.meeting(id)?.revision == 23 && store.meeting(id)?.syncedRevision == 22)
        precondition(store.meeting(id)?.title == "Mac edited" && store.meeting(id)?.projectId == nil)
        precondition(store.syncErrors[id] == nil && store.errorMessage == nil)
        store.update(id) { $0.status = "recording" }
        RecoveryProtocol.setReplies([])
        try await store.syncMeeting(id, client: api, identity: "mac", finalOnly: true)
        precondition(RecoveryProtocol.bodies.isEmpty, "A queued final sync must skip a resumed run")
        store.update(id) { $0.status = "ended" }

        let previous = store.meeting(id)!
        try store.prepareSyncCopy(id)
        let copied = store.meeting(id)!
        precondition(copied.syncClientId != nil && copied.syncClientId != previous.syncClientId)
        precondition(copied.remoteId == nil && copied.syncedRevision == nil && copied.syncedServer == nil)
        let reopened = MeetingStore(demo: false, directory: root)
        precondition(
            reopened.meeting(id)?.syncClientId == copied.syncClientId, "Copy identity survives a relaunch before upload"
        )
        let obsolete = try SyncRecovery.reconcile(
            .init(sessionId: "old-response", revision: previous.revision), sent: previous, current: copied)
        precondition(obsolete == nil)
        RecoveryProtocol.setReplies([.failure(.notConnectedToInternet)])
        do {
            try await reopened.syncMeeting(id, client: api, identity: "mac"); fatalError("Expected offline")
        } catch ConnectionError.transport {}
        precondition(RecoveryProtocol.bodies.first?["clientId"] as? String == copied.syncClientId?.uuidString)
        precondition(reopened.meeting(id)?.syncClientId == copied.syncClientId && reopened.errorMessage == nil)
        RecoveryProtocol.setReplies([.http(200, "{\"sessionId\":\"new-copy\",\"revision\":\(copied.revision)}")])
        try await reopened.syncMeeting(id, client: api, identity: "mac")
        precondition(reopened.meeting(id)?.remoteId == "new-copy" && reopened.syncErrors[id] == nil)
        reopened.forgetRemote(id, remoteId: "new-copy", identity: "mac")
        precondition(reopened.meeting(id)?.remoteId == nil && reopened.meeting(id)?.syncClientId == copied.syncClientId)
        RecoveryProtocol.setReplies([.http(200, "{\"sessionId\":\"recreated\",\"revision\":\(copied.revision)}")])
        try await reopened.syncMeeting(id, client: api, identity: "mac")
        precondition(reopened.meeting(id)?.remoteId == "recreated")

        let rollback = MeetingStore(demo: false, directory: directory.appendingPathComponent("rollback"))
        let rollbackId = try rollback.create(title: "Rollback", type: "other")
        let original = rollback.meeting(rollbackId)!
        try FileManager.default.removeItem(at: rollback.fileURL)
        try FileManager.default.createDirectory(at: rollback.fileURL, withIntermediateDirectories: true)
        do { try rollback.prepareSyncCopy(rollbackId); fatalError("Must persist identity before upload") } catch {}
        precondition(rollback.meeting(rollbackId) == original)

        reopened.saveOutput(.init(id: "scoped", kind: "answer", status: "pending"), meetingId: id)
        let other = try reopened.create(title: "Unaffected", type: "other")
        RecoveryProtocol.setReplies([.failure(.cannotConnectToHost)])
        reopened.pollOutput("scoped", meetingId: id, client: api, identity: "mac")
        try await Task.sleep(nanoseconds: 100_000_000)
        precondition(reopened.outputErrors[id] == nil && reopened.errorMessage == nil, "Background polls stay silent")
        RecoveryProtocol.setReplies([.failure(.timedOut)])
        reopened.pollOutput("scoped", meetingId: id, client: api, identity: "mac", reportingErrors: true)
        let deadline = Date().addingTimeInterval(2)
        while reopened.outputErrors[id]?["scoped"] == nil && Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        precondition(reopened.outputErrors[id]?["scoped"] != nil && reopened.outputErrors[other] == nil)
        precondition(reopened.errorMessage == nil)
        RecoveryProtocol.setReplies([
            .http(200, #"{"output":{"id":"scoped","kind":"answer","status":"done","text":"Recovered"}}"#)
        ])
        reopened.pollOutput("scoped", meetingId: id, client: api, identity: "mac", reportingErrors: true)
        let successDeadline = Date().addingTimeInterval(2)
        while reopened.outputErrors[id]?["scoped"] != nil && Date() < successDeadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        precondition(
            reopened.outputErrors[id]?["scoped"] == nil && reopened.meeting(id)?.outputs.first?.content == "Recovered")
        reopened.errorMessage = "Previous persistence error"
        reopened.update(other) { $0.title = "Successful save" }
        precondition(reopened.errorMessage == nil)
    }
}

private final class RecoveryProtocol: URLProtocol {
    enum Reply { case http(Int, String), failure(URLError.Code) }
    private static let lock = NSLock()
    private static var replies: [Reply] = []
    private static var requests: [[String: Any]] = []
    static var bodies: [[String: Any]] { lock.lock(); defer { lock.unlock() }; return requests }
    static func setReplies(_ values: [Reply]) {
        lock.lock(); defer { lock.unlock() }
        replies = values; requests = []
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        Self.lock.lock()
        Self.requests.append((try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:])
        let reply = Self.replies.isEmpty ? Reply.failure(.badServerResponse) : Self.replies.removeFirst()
        Self.lock.unlock()
        switch reply {
        case .failure(let code): client?.urlProtocol(self, didFailWithError: URLError(code))
        case .http(let status, let body):
            client?.urlProtocol(
                self,
                didReceive: HTTPURLResponse(
                    url: request.url!, statusCode: status, httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}

/// URLProtocol keeps networking checks entirely inside the test process.
private final class StubMobileProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var polls = 0
    static var pollCount: Int { lock.lock(); defer { lock.unlock() }; return polls }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        var status = 200
        let body: String
        if path.hasSuffix("/deleted") {
            status = 404
            body = #"{"error":"Mobile session not found.","code":"not_found"}"#
        } else if path.contains("/outputs/") {
            Self.lock.lock(); Self.polls += 1; let count = Self.polls; Self.lock.unlock()
            body =
                count == 1
                ? #"{"output":{"id":"pending","kind":"answer","status":"pending"}}"#
                : #"{"output":{"id":"pending","kind":"answer","status":"done","text":"Finished answer"}}"#
        } else {
            body = #"{"outputs":[{"id":"mac","kind":"final_summary","status":"done","text":"Mac summary"}]}"#
        }
        client?.urlProtocol(
            self,
            didReceive: HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
