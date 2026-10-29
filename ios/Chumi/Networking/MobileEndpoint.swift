import Foundation

struct PairingCredentials: Codable, Equatable {
    var url: String
    var token: String
    var certificateSHA256: String?

    func validated(allowSimulatorHTTP: Bool = false) throws -> PairingCredentials {
        let endpoint = try MobileEndpoint(url, allowSimulatorHTTP: allowSimulatorHTTP)
        let cleanToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleanToken.count >= 32, cleanToken.count <= 512,
            !cleanToken.contains(where: { $0.isWhitespace || $0.isNewline })
        else { throw ConnectionError.invalidToken }
        let pin = certificateSHA256?.replacingOccurrences(of: ":", with: "").trimmingCharacters(
            in: .whitespacesAndNewlines
        ).lowercased()
        if let pin, !pin.isEmpty {
            guard pin.count == 64, pin.allSatisfy({ $0.isHexDigit && $0.isASCII }) else {
                throw ConnectionError.invalidPin
            }
        }
        return .init(
            url: endpoint.baseURL.absoluteString, token: cleanToken,
            certificateSHA256: pin?.isEmpty == false ? pin : nil)
    }
}

struct MobileEndpoint {
    let baseURL: URL
    let host: String

    init(_ raw: String, allowSimulatorHTTP: Bool = false) throws {
        guard var parts = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
            let scheme = parts.scheme?.lowercased(), let host = parts.host?.lowercased(), !host.isEmpty,
            parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
            ["", "/", "/mobile/v1", "/mobile/v1/"].contains(parts.path),
            parts.port == nil || (1...65535).contains(parts.port!)
        else { throw ConnectionError.invalidURL }
        let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
        guard scheme == "https" || (scheme == "http" && allowSimulatorHTTP && loopback) else {
            throw ConnectionError.httpsRequired
        }
        parts.scheme = scheme; parts.path = ""; parts.host = host
        guard let url = parts.url else { throw ConnectionError.invalidURL }
        baseURL = url; self.host = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    }

    func url(_ path: String) throws -> URL {
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.isEmpty,
            components.allSatisfy({ part in
                !part.isEmpty && part != "." && part != ".."
                    && part.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
            })
        else { throw ConnectionError.invalidURL }
        return components.reduce(baseURL.appendingPathComponent("mobile/v1")) { $0.appendingPathComponent(String($1)) }
    }
}

enum ConnectionError: LocalizedError {
    case invalidURL, httpsRequired, invalidToken, invalidPin, keychain(Int32), invalidResponse, certificateChanged,
        transport(URLError.Code), server(Int, String?, revision: Int? = nil)
    var recovery: String? {
        switch self {
        case .certificateChanged: return "pair"
        case .server(let status, let code, _):
            if status == 401 || code == "unauthorized" { return "pair" }
            if code == "invalid_project" { return "project" }
            if code == "not_found" { return "sync" }
            if status == 409
                && ["stale_revision", "revision_conflict", "segment_conflict", "session_conflict"].contains(code ?? "")
            {
                return "copy"
            }
            return nil
        default: return nil
        }
    }

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return String(
                localized:
                    "Enter your Mac service address, such as https://My-Mac.local:4778, without credentials, query parameters, or other paths."
            )
        case .httpsRequired:
            return String(
                localized:
                    "An iPhone requires HTTPS. Use the pairing code from your Mac. HTTP is only available for a simulator connecting to localhost."
            )
        case .invalidToken:
            return String(localized: "The pairing token is invalid. Copy the pairing code from your Mac again.")
        case .invalidPin:
            return String(localized: "The certificate fingerprint must contain 64 SHA-256 hexadecimal characters.")
        case .keychain:
            return String(localized: "Could not save the connection to Keychain. Unlock your device and try again.")
        case .invalidResponse:
            return String(
                localized:
                    "Your Mac returned an unreadable response. Update Chumi on your Mac and enable the mobile companion service."
            )
        case .certificateChanged:
            return String(
                localized:
                    "Your Mac certificate has changed. Open connection settings and paste a new pairing code from your Mac."
            )
        case .transport(let code):
            switch code {
            case .cannotFindHost, .cannotConnectToHost, .timedOut, .notConnectedToInternet, .networkConnectionLost,
                .dataNotAllowed:
                return String(
                    localized:
                        "Cannot reach your Mac. Run npm run start:mobile on the Mac, connect both devices to the same Wi-Fi, and allow Chumi in Settings → Privacy & Security → Local Network. Then try again."
                )
            case .cancelled: return String(localized: "The connection was cancelled. Try again.")
            default:
                return String(
                    localized:
                        "Could not establish a secure connection. Check the Mac service and pairing code, then try again."
                )
            }
        case .server(let status, let code, _):
            switch code {
            case "unauthorized":
                return String(localized: "Pairing has expired. Paste a new pairing code from your Mac.")
            case "stale_revision", "revision_conflict", "segment_conflict", "session_conflict":
                return String(
                    localized:
                        "This transcript conflicts with the Mac copy. Upload it as a new copy to keep both versions.")
            case "invalid_request":
                return String(
                    localized:
                        "The Mac rejected this meeting data. Export a backup and update Chumi on both devices before syncing again."
                )
            case "invalid_project":
                return String(
                    localized:
                        "This Mac project is no longer available. Choose another project or remove the link, then sync again."
                )
            case "not_found": return String(localized: "This record is missing on your Mac. Sync the meeting again.")
            case "body_too_large", "payload_too_large":
                return String(localized: "The transcript exceeds 4 MiB. Export it and continue on your computer.")
            default:
                if status == 401 {
                    return String(localized: "Pairing has expired. Paste a new pairing code from your Mac.")
                }
                return String(localized: "Your Mac could not complete the request (\(status)). Try again later.")
            }
        }
    }
}
