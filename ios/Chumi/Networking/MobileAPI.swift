import CryptoKit
import Foundation
import Security

struct MobileHealth: Decodable { let ok: Bool }
struct MobileProject: Codable, Identifiable, Hashable { let id: String; let name: String }
struct ProjectsResponse: Decodable { let projects: [MobileProject] }
struct SyncMetadata: Decodable, Equatable { let title: String; let type: String; let projectId: String? }
struct SyncResponse: Decodable {
    let sessionId: String
    let revision: Int
    var metadata: SyncMetadata? = nil
    var id: String { sessionId }
}
struct OutputTicket: Decodable { let outputId: String; var id: String { outputId } }
struct OutputResponse: Decodable { let output: AssistantOutput }
struct MobileSessionDetail: Decodable { let outputs: [AssistantOutput] }
struct MobileFailure: Decodable { let error: String?; let code: String?; let revision: Int? }

private final class PinnedSessionDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
    let host: String
    let pin: String?
    private let lock = NSLock()
    private var rejectedPin = false
    var pinMismatch: Bool { lock.lock(); defer { lock.unlock() }; return rejectedPin }
    private func rejectPin() { lock.lock(); rejectedPin = true; lock.unlock() }
    init(host: String, pin: String?) { self.host = host; self.pin = pin }

    func urlSession(
        _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            completionHandler(.performDefaultHandling, nil); return
        }
        guard let pin else { completionHandler(.performDefaultHandling, nil); return }
        guard challenge.protectionSpace.host.lowercased() == host,
            let trust = challenge.protectionSpace.serverTrust,
            let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first
        else {
            rejectPin()
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        let digest = SHA256.hash(data: SecCertificateCopyData(leaf) as Data).map { String(format: "%02x", $0) }.joined()
        guard digest == pin else { rejectPin(); completionHandler(.cancelAuthenticationChallenge, nil); return }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
    ) {
        // Never forward the bearer credential to a redirected origin or endpoint.
        completionHandler(nil)
    }
}

final class MobileAPI {
    let endpoint: MobileEndpoint
    private let token: String
    private let session: URLSession
    private let delegate: PinnedSessionDelegate

    init(credentials: PairingCredentials, configuration: URLSessionConfiguration = .ephemeral) throws {
        let checked = try credentials.validated(allowSimulatorHTTP: ConnectionStore.allowsSimulatorHTTP)
        endpoint = try MobileEndpoint(checked.url, allowSimulatorHTTP: ConnectionStore.allowsSimulatorHTTP)
        token = checked.token
        configuration.timeoutIntervalForRequest = 25
        configuration.timeoutIntervalForResource = 35
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        delegate = PinnedSessionDelegate(host: endpoint.host, pin: checked.certificateSHA256)
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    func health() async throws -> MobileHealth { try await request("health") }
    func projects() async throws -> [MobileProject] {
        let response: ProjectsResponse = try await request("projects"); return response.projects
    }

    func sync(_ meeting: Meeting) async throws -> SyncResponse {
        do { return try await upload(meeting) } catch let error as ConnectionError {
            guard let revision = SyncRecovery.retryRevision(for: error, sentRevision: meeting.revision, retries: 0)
            else { throw error }
            var retry = meeting
            retry.revision = revision
            return try await upload(retry)
        }
    }

    private func upload(_ meeting: Meeting) async throws -> SyncResponse {
        try meeting.validate()
        struct Snapshot: Encodable {
            let clientId: String; let revision: Int; let title: String; let startedAt: Double; let durationMs: Int
            let status: String; let type: String; let projectId: String?; let segments: [TranscriptSegment]
        }
        let snapshot = Snapshot(
            clientId: (meeting.syncClientId ?? meeting.id).uuidString, revision: meeting.revision, title: meeting.title,
            startedAt: meeting.startedAt, durationMs: meeting.durationMs, status: meeting.status,
            type: meeting.type, projectId: meeting.projectId, segments: meeting.segments)
        let body = try JSONEncoder().encode(snapshot)
        guard body.count <= 4 * 1024 * 1024 else { throw ConnectionError.server(413, "body_too_large") }
        return try await request("sessions", body: body)
    }

    func ask(sessionId: String, question: String, projectContext: Bool) async throws -> OutputTicket {
        struct Body: Encodable { let question: String; let projectContext: Bool }
        return try await request(
            "sessions/\(sessionId)/ask",
            body: JSONEncoder().encode(Body(question: question, projectContext: projectContext)))
    }

    func catchup(sessionId: String, scope: String) async throws -> OutputTicket {
        struct Body: Encodable { let scope: String }
        return try await request("sessions/\(sessionId)/catchup", body: JSONEncoder().encode(Body(scope: scope)))
    }

    func summary(sessionId: String) async throws -> OutputTicket {
        try await request("sessions/\(sessionId)/summary", body: Data("{}".utf8))
    }
    func detail(sessionId: String) async throws -> MobileSessionDetail {
        try await request("sessions/\(sessionId)")
    }

    func output(id: String) async throws -> AssistantOutput {
        let response: OutputResponse = try await request("outputs/\(id)"); return response.output
    }

    private func request<T: Decodable>(_ path: String, body: Data? = nil) async throws -> T {
        var request = URLRequest(url: try endpoint.url(path))
        request.httpMethod = body == nil ? "GET" : "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            try Task.checkCancellation()
            if delegate.pinMismatch { throw ConnectionError.certificateChanged }
            if let urlError = error as? URLError { throw ConnectionError.transport(urlError.code) }
            throw error
        }
        guard let response = response as? HTTPURLResponse else { throw ConnectionError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else {
            let failure = try? JSONDecoder().decode(MobileFailure.self, from: data)
            throw ConnectionError.server(response.statusCode, failure?.code, revision: failure?.revision)
        }
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw ConnectionError.invalidResponse }
    }
}
