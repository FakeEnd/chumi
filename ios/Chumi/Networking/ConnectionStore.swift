import Combine
import Foundation
import Security

@MainActor
final class ConnectionStore: ObservableObject {
    @Published private(set) var credentials: PairingCredentials?
    @Published var errorMessage: String?
    private let service = "app.chumi.mobile.connection"
    private let account = "paired-mac-v1"
    let isDemo: Bool

    nonisolated static var allowsSimulatorHTTP: Bool {
        #if targetEnvironment(simulator)
            return true
        #else
            return false
        #endif
    }

    init(demo: Bool = ProcessInfo.processInfo.arguments.contains("--demo")) {
        isDemo = demo
        guard !demo else { return }
        var query = keychainQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return }
        guard status == errSecSuccess, let data = result as? Data else {
            errorMessage = ConnectionError.keychain(status).localizedDescription; return
        }
        do {
            credentials = try JSONDecoder().decode(PairingCredentials.self, from: data).validated(
                allowSimulatorHTTP: Self.allowsSimulatorHTTP)
        } catch {
            errorMessage = String(localized: "The saved connection is unavailable: \(error.localizedDescription)")
        }
    }

    func save(_ value: PairingCredentials) throws {
        guard !isDemo else { return }
        let checked = try value.validated(allowSimulatorHTTP: Self.allowsSimulatorHTTP)
        let data = try JSONEncoder().encode(checked)
        let update =
            [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
            as [String: Any]
        let status = SecItemUpdate(keychainQuery as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var insert = keychainQuery
            update.forEach { insert[$0.key] = $0.value }
            let added = SecItemAdd(insert as CFDictionary, nil)
            guard added == errSecSuccess else { throw ConnectionError.keychain(added) }
        } else if status != errSecSuccess {
            throw ConnectionError.keychain(status)
        }
        credentials = checked
    }

    func disconnect() throws {
        guard !isDemo else { return }
        let status = SecItemDelete(keychainQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw ConnectionError.keychain(status) }
        credentials = nil
    }

    var identity: String? {
        credentials.map { $0.url + "|" + ($0.certificateSHA256 ?? "system-trust") }
    }

    func client() throws -> MobileAPI {
        guard !isDemo, let credentials else { throw MeetingError.missingConnection }
        return try MobileAPI(credentials: credentials)
    }

    private var keychainQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
