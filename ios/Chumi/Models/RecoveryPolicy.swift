import Foundation

/// Recovery counters and decisions shared by every upload path.
enum SyncRecovery {
    static let maximumRevision = 9_007_199_254_740_991

    static func retryRevision(for error: ConnectionError, sentRevision: Int, retries: Int) -> Int? {
        guard retries == 0, case .server(409, "stale_revision", let revision) = error,
            let revision, revision >= sentRevision, revision < maximumRevision
        else { return nil }
        return revision + 1
    }

    static func reconcile(_ response: SyncResponse, sent: Meeting, current: Meeting) throws -> Meeting? {
        guard (current.syncClientId ?? current.id) == (sent.syncClientId ?? sent.id) else { return nil }
        guard response.revision >= sent.revision, response.revision <= maximumRevision,
            current.revision >= sent.revision,
            current.revision <= maximumRevision - (response.revision - sent.revision)
        else { throw ConnectionError.invalidResponse }
        var result = current
        result.revision += response.revision - sent.revision
        result.remoteId = response.id
        result.syncedRevision = response.revision
        if let metadata = response.metadata {
            if current.title == sent.title { result.title = metadata.title }
            if current.type == sent.type { result.type = metadata.type }
            if current.projectId == sent.projectId { result.projectId = metadata.projectId }
            // The next upload has different metadata from the acknowledged request body.
            if result.revision == response.revision
                && (result.title != sent.title || result.type != sent.type || result.projectId != sent.projectId)
            {
                guard result.revision < maximumRevision else { throw ConnectionError.invalidResponse }
                result.revision += 1
            }
        }
        try result.validate()
        return result
    }
}

enum RequestFeedback {
    static func shouldPresent(_ error: Error, automatic: Bool) -> Bool {
        guard automatic else { return true }
        if case ConnectionError.transport = error { return false }
        if error is URLError { return false }
        if case MeetingError.pollingTimeout = error { return false }
        return true
    }
}

struct RequestIssue: Equatable {
    let message: String
    let recovery: String?
    init(_ error: Error) {
        message = error.localizedDescription
        recovery = (error as? ConnectionError)?.recovery
    }
}

/// A foreground return may resume a recent interruption, never an hours-old one.
struct RecordingRecovery {
    private(set) var requestedAt: TimeInterval?
    private(set) var allowed = false
    private(set) var attempts = 0
    static let maximumDelay: TimeInterval = 120

    mutating func request(at time: TimeInterval, awaitingInterruptionEnd: Bool = false) {
        // Route notifications during a call must neither grant resume nor extend its deadline.
        if requestedAt == nil {
            requestedAt = time
            allowed = !awaitingInterruptionEnd
        } else if awaitingInterruptionEnd {
            allowed = false
        }
    }
    mutating func interruptionEnded(shouldResume: Bool) {
        if shouldResume { allowed = true } else { cancel() }
    }
    mutating func cancel() { requestedAt = nil; allowed = false }
    mutating func reset() { cancel(); attempts = 0 }
    mutating func markHealthy() { attempts = 0 }
    mutating func takeResume(at time: TimeInterval, active: Bool) -> Bool {
        guard let requestedAt else { return false }
        guard time >= requestedAt, time - requestedAt <= Self.maximumDelay else { cancel(); return false }
        guard allowed, active else { return false }
        cancel()
        guard attempts < 2 else { return false }
        attempts += 1
        return true
    }
}

enum RecordingInputKind { case builtIn, headset, external, other }
enum RecordingRunPolicy {
    static func preferBuiltIn(over inputs: [RecordingInputKind]) -> Bool {
        inputs.contains(.headset) && !inputs.contains(.external)
    }
    static func keepAudio(durationMs: Int) -> Bool { durationMs > 0 }
    static func syncAfterStop(automaticallyResuming: Bool) -> Bool { !automaticallyResuming }
}
