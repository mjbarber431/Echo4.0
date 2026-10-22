import Foundation
import Security

/// What the phone learns from the Mac's pairing code:
/// `echo://pair?v=1&id=<pairing id>&key=<base64url 32-byte key>&name=<Mac name>`.
/// Kept in the Keychain, on this device only, readable only while it's unlocked.
struct Pairing: Codable, Equatable, Sendable {
    let id: String
    let key: Data
    let macName: String

    init?(code: String) {
        guard let url = URLComponents(string: code), url.scheme == "echo", url.host == "pair" else { return nil }
        let items = Dictionary((url.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        guard items["v"] == "1", let id = items["id"], !id.isEmpty, let key = items["key"].flatMap(Data.init(base64URL:)), key.count == 32 else { return nil }
        self.id = id
        self.key = key
        self.macName = items["name"].flatMap { $0.isEmpty ? nil : $0 } ?? "your Mac"
    }

    private static let account = "pairing"
    private static let service = "care.person2person.echo.mobile"

    static func load() -> Pairing? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(Pairing.self, from: data)
    }

    func save() throws {
        Pairing.forget()
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Pairing.service,
            kSecAttrAccount as String: Pairing.account,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: try JSONEncoder().encode(self),
        ]
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }

    static func forget() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

extension Data {
    init?(base64URL: String) {
        var s = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        s += String(repeating: "=", count: (4 - s.count % 4) % 4)
        self.init(base64Encoded: s)
    }
}
