import CryptoKit
import Foundation
import Network
import os
import Observation
import UIKit

/// Finds the paired Mac on the local network and hands it transcripts.
///
/// Wire format (the Mac's side is src/main/link.ts): Bonjour service
/// `_echo-memo._tcp` with TXT `pid=<pairing id>`. One request and one reply per
/// connection, each a 4-byte big-endian length then an AES-256-GCM sealed box
/// (CryptoKit `combined`: nonce, ciphertext, tag) with AAD
/// "echo-memo/1 request <id>" or "echo-memo/1 reply <id>".
///   request: {"device","memos":[{"id","recordedAt","durationSec","transcript"}]}
///   reply:   {"received":[ids],"mac":"<name>"}
/// An empty reply frame means the Mac no longer knows this phone's key.
@MainActor @Observable
final class MacLink {
    enum State: Equatable {
        case unpaired
        /// Paired, but the Mac isn't on this network or Echo isn't open on it.
        case searching
        case found
        case sending
        /// Local Network access is off, or the Mac has forgotten this phone.
        case blocked(String)
    }

    private(set) var pairing: Pairing?
    private(set) var state: State
    private(set) var lastContact: Date?

    private var browser: NWBrowser?
    private var endpoint: NWEndpoint?

    init() {
        let pairing = Pairing.load()
        self.pairing = pairing
        state = pairing == nil ? .unpaired : .searching
    }

    var macName: String { pairing?.macName ?? "your Mac" }

    func pair(with pairing: Pairing) throws {
        try pairing.save()
        self.pairing = pairing
        stop()
        state = .searching
        start()
    }

    func unpair() {
        Pairing.forget()
        stop()
        pairing = nil
        state = .unpaired
    }

    /// Looks for the Mac while the app is open. iOS doesn't allow browsing in the background.
    func start() {
        guard let pairing, browser == nil else { return }
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_echo-memo._tcp", domain: nil), using: .tcp)
        browser.stateUpdateHandler = { [weak self] update in
            Task { @MainActor in self?.browserChanged(update) }
        }
        browser.browseResultsChangedHandler = { [weak self, weak browser] results, _ in
            let match = results.first { result in
                if case let .bonjour(txt) = result.metadata { return txt["pid"] == pairing.id }
                return false
            }
            Task { @MainActor in
                // Results from a browser replaced by re-pairing belong to the old Mac.
                guard let self, let browser, self.browser === browser else { return }
                self.found(match?.endpoint)
            }
        }
        browser.start(queue: .main)
        self.browser = browser
    }

    func stop() {
        browser?.cancel()
        browser = nil
        endpoint = nil
        if pairing != nil, state != .sending { state = .searching }
    }

    private func browserChanged(_ update: NWBrowser.State) {
        switch update {
        case let .waiting(error), let .failed(error):
            if case .dns(let code) = error, code == -65570 /* kDNSServiceErr_PolicyDenied */ {
                state = .blocked("Turn on Local Network for Echo in Settings › Privacy & Security › Local Network.")
            } else if case .failed = update {
                // Restart on the next foreground.
                browser?.cancel()
                browser = nil
            }
        default:
            break
        }
    }

    private func found(_ endpoint: NWEndpoint?) {
        self.endpoint = endpoint
        guard state != .sending else { return }
        if case .blocked(let reason) = state, reason.hasPrefix("Turn on Local Network"), endpoint == nil { return }
        state = endpoint == nil ? .searching : .found
        if endpoint != nil { onFound?() }
    }

    /// Called when the Mac appears, so anything waiting is sent straight away.
    var onFound: (() -> Void)?

    var canSend: Bool { pairing != nil && endpoint != nil && state == .found }

    /// Sends transcripts and returns the ids the Mac has saved. An empty list just checks in.
    func send(_ memos: [Memo]) async throws -> Set<UUID> {
        guard let pairing, let endpoint else { throw LinkError.notFound }
        state = .sending
        do {
            let ids = try await exchange(memos, pairing: pairing, endpoint: endpoint)
            lastContact = Date()
            state = self.endpoint == nil ? .searching : .found
            return ids
        } catch LinkError.forgotten {
            state = .blocked("\(pairing.macName) no longer recognizes this iPhone. Pair again from Echo’s Settings on your Mac.")
            throw LinkError.forgotten
        } catch {
            state = self.endpoint == nil ? .searching : .found
            throw error
        }
    }

    private struct Request: Encodable {
        struct Item: Encodable {
            let id: String
            let recordedAt: String
            let durationSec: Double
            let transcript: String
        }
        let device: String
        let memos: [Item]
    }

    private struct Reply: Decodable {
        let received: [String]
        let mac: String?
    }

    private func exchange(_ memos: [Memo], pairing: Pairing, endpoint: NWEndpoint) async throws -> Set<UUID> {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let request = Request(
            device: deviceName(),
            memos: memos.compactMap { m in
                m.transcript.map { .init(id: m.id.uuidString.lowercased(), recordedAt: iso.string(from: m.recordedAt), durationSec: m.duration, transcript: $0) }
            }
        )
        let key = SymmetricKey(data: pairing.key)
        let box = try AES.GCM.seal(try JSONEncoder().encode(request), using: key, authenticating: Data("echo-memo/1 request \(pairing.id)".utf8))
        guard let sealed = box.combined else { throw LinkError.badReply }

        let reply = try await Exchange.run(endpoint: endpoint, payload: sealed)
        if reply.isEmpty { throw LinkError.forgotten }
        let opened = try AES.GCM.open(AES.GCM.SealedBox(combined: reply), using: key, authenticating: Data("echo-memo/1 reply \(pairing.id)".utf8))
        let decoded = try JSONDecoder().decode(Reply.self, from: opened)
        return Set(decoded.received.compactMap(UUID.init(uuidString:)))
    }

    private func deviceName() -> String {
        // iOS reports just "iPhone" without a special entitlement, which is fine.
        UIDevice.current.name
    }
}

enum LinkError: LocalizedError {
    case notFound
    case forgotten
    case badReply
    case timedOut

    var errorDescription: String? {
        switch self {
        case .notFound: "Your Mac isn’t on this network right now."
        case .forgotten: "Your Mac no longer recognizes this iPhone."
        case .badReply: "Your Mac sent a reply Echo couldn’t read."
        case .timedOut: "Your Mac didn’t answer in time."
        }
    }
}

/// One framed request and reply over a fresh TCP connection.
private enum Exchange {
    static let log = Logger(subsystem: "care.person2person.echo.mobile", category: "link")

    static func run(endpoint: NWEndpoint, payload: Data) async throws -> Data {
        let connection = NWConnection(to: endpoint, using: .tcp)
        defer { connection.cancel() }
        return try await withThrowingTaskGroup(of: Data.self) { group in
            group.addTask { try await talk(connection, payload) }
            group.addTask {
                try await Task.sleep(for: .seconds(20))
                // The group waits for every child, so the exchange has to be stopped, not just abandoned.
                connection.cancel()
                throw LinkError.timedOut
            }
            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }

    private static func talk(_ connection: NWConnection, _ payload: Data) async throws -> Data {
        try await ready(connection)
        log.info("ready")
        var length = UInt32(payload.count).bigEndian
        var frame = Data(bytes: &length, count: 4)
        frame.append(payload)
        try await send(connection, frame)
        log.info("sent \(frame.count) bytes")
        let head = try await receive(connection, 4)
        let size = head.withUnsafeBytes { Int(UInt32(bigEndian: $0.loadUnaligned(as: UInt32.self))) }
        if size == 0 { return Data() }
        guard size < 1_000_000 else { throw LinkError.badReply }
        return try await receive(connection, size)
    }

    private static func ready(_ connection: NWConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let once = Once()
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready: once.run { continuation.resume() }
                case let .failed(error), let .waiting(error): once.run { continuation.resume(throwing: error) }
                case .cancelled: once.run { continuation.resume(throwing: CancellationError()) }
                default: break
                }
            }
            connection.start(queue: .global(qos: .userInitiated))
        }
    }

    private static func send(_ connection: NWConnection, _ data: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            })
        }
    }

    private static func receive(_ connection: NWConnection, _ count: Int) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            connection.receive(minimumIncompleteLength: count, maximumLength: count) { data, _, _, error in
                if let error { continuation.resume(throwing: error) }
                else if let data, data.count == count { continuation.resume(returning: data) }
                else { continuation.resume(throwing: LinkError.badReply) }
            }
        }
    }
}

/// Resumes a continuation only once, whatever the connection reports afterwards.
private final class Once: @unchecked Sendable {
    private var done = false
    private let lock = NSLock()
    func run(_ body: () -> Void) {
        lock.lock()
        defer { lock.unlock() }
        guard !done else { return }
        done = true
        body()
    }
}
