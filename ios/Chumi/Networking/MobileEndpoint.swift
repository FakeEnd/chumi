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
    case invalidURL, httpsRequired, invalidToken, invalidPin, keychain(Int32), invalidResponse, server(Int, String)
    var errorDescription: String? {
        switch self {
        case .invalidURL: return "请输入 Mac 的服务地址，例如 https://My-Mac.local:4778。地址不能包含账号、查询参数或其他路径。"
        case .httpsRequired: return "真机连接需要 HTTPS。请使用 Mac 生成的配对码；HTTP 仅用于模拟器连接本机。"
        case .invalidToken: return "配对令牌格式无效，请重新复制 Mac 生成的配对码。"
        case .invalidPin: return "证书指纹应为 64 位 SHA-256 十六进制字符串。"
        case .keychain: return "无法安全保存连接信息到钥匙串。请解锁设备后重试。"
        case .invalidResponse: return "Mac 返回了无法识别的响应。请确认电脑端已更新并启用手机连接。"
        case .server(let status, let detail): return "Mac 返回错误（\(status)）：\(detail)"
        }
    }
}
