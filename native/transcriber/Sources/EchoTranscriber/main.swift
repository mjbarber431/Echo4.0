import FluidAudio
import Foundation

// Echo's local transcriber. Audio never leaves the Mac: Parakeet runs on the
// Neural Engine through Core ML.
//
// Protocol: one JSON object per line. Requests arrive on stdin and are handled
// in order; replies go to stdout with the request's id.
//   {"id":1,"op":"prepare","dir":"<models folder>","model":"parakeet-tdt-0.6b-v2"}
//       → zero or more {"id":1,"type":"progress","fraction":0.4,"phase":"downloading"}
//       → {"id":1,"type":"result","ok":true}
//   {"id":2,"op":"vocabulary","dir":"<models folder>","terms":[{"text":"sertraline","aliases":[…]}]}
//       → progress as for prepare, then {"id":2,"type":"result","ok":true,"count":n}
//       Loads the vocabulary checker (VocabularyChecker.swift) for these terms, downloading its model
//       the first time. It runs alongside transcription, which uses the checker once it's ready.
//   {"id":3,"op":"transcribe","pcm":"<base64 16 kHz mono 16-bit little-endian PCM>"}
//       → {"id":3,"type":"result","ok":true,"text":"…"}
// A failure is {"id":n,"type":"result","ok":false,"error":"…"}.
//
// Nothing here logs audio or text. FluidAudio's debug lines include transcript
// text, so its logger is held to warnings and kept off the console.

AppLogger.minimumLevel = .warning
AppLogger.mirrorsToConsole = false

// stdout is the protocol channel. Point fd 1 at stderr so a stray print from a
// dependency can't corrupt it, and write replies to a private copy instead.
let replyFd = dup(STDOUT_FILENO)
dup2(STDERR_FILENO, STDOUT_FILENO)
let replies = FileHandle(fileDescriptor: replyFd, closeOnDealloc: false)
let replyLock = NSLock()

func reply(_ object: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
    data.append(0x0A)
    replyLock.lock()
    defer { replyLock.unlock() }
    replies.write(data)
}

func fail(_ id: Int, _ message: String) {
    reply(["id": id, "type": "result", "ok": false, "error": message])
}

let models: [String: (version: AsrModelVersion, folder: String)] = [
    "parakeet-tdt-0.6b-v2": (.v2, Repo.parakeetV2.folderName),
    "parakeet-tdt-0.6b-v3": (.v3, Repo.parakeetV3.folderName),
]

/// 16-bit PCM to the [-1, 1] floats the model takes.
func samples(fromBase64 pcm: String) -> [Float]? {
    guard let data = Data(base64Encoded: pcm), data.count % 2 == 0 else { return nil }
    return data.withUnsafeBytes { raw in
        raw.bindMemory(to: Int16.self).map { Float(Int16(littleEndian: $0)) / 32768 }
    }
}

actor Transcriber {
    private var manager: AsrManager?
    private var loaded: String?
    private var decoderLayers = 2

    func prepare(id: Int, dir: String, model: String) async throws {
        guard let spec = models[model] else { throw HelperError("Unknown transcription model: \(model)") }
        if loaded == model { return }
        let target = URL(fileURLWithPath: dir).appendingPathComponent(spec.folder)
        let asr = try await AsrModels.downloadAndLoad(to: target, version: spec.version) { progress in
            reply(["id": id, "type": "progress", "fraction": progress.fractionCompleted, "phase": "\(progress.phase)"])
        }
        await manager?.cleanup()
        let next = AsrManager(config: .default)
        try await next.loadModels(asr)
        manager = next
        decoderLayers = asr.version.decoderLayers
        loaded = model
    }

    func transcribe(_ audio: [Float]) async throws -> String {
        guard let manager else { throw HelperError("The transcription model isn't loaded yet.") }
        // Under a quarter second there's nothing to transcribe, and the model rejects very short input.
        if audio.count < 4000 { return "" }
        // A fresh decoder state per request: every recording and live turn stands alone.
        var state = TdtDecoderState.make(decoderLayers: decoderLayers)
        let result = try await manager.transcribe(audio, decoderState: &state)
        let text = await checking.checker?.check(result, audio: audio) ?? result.text
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// The vocabulary checker, kept apart from the transcriber so loading it never holds up a transcription.
actor Checking {
    private(set) var checker: VocabularyChecker?
    private var models: CtcModels?

    func load(id: Int, dir: String, terms: [VocabularyEntry]) async throws -> Int {
        let modelsDir = URL(fileURLWithPath: dir)
        if models == nil {
            if !VocabularyChecker.modelsExist(in: modelsDir) {
                reply(["id": id, "type": "progress", "fraction": 0, "phase": "downloading"])
            }
            models = try await VocabularyChecker.loadModels(in: modelsDir)
        }
        guard let models else { throw HelperError("The vocabulary model didn't load.") }
        let next = try await VocabularyChecker(models: models, modelsDir: modelsDir, entries: terms)
        checker = next
        return next.entries.count
    }
}

let checking = Checking()

struct HelperError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

let transcriber = Transcriber()

while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8),
        let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let id = request["id"] as? Int,
        let op = request["op"] as? String
    else { continue }

    do {
        switch op {
        case "prepare":
            guard let dir = request["dir"] as? String, let model = request["model"] as? String else {
                throw HelperError("prepare needs dir and model.")
            }
            try await transcriber.prepare(id: id, dir: dir, model: model)
            reply(["id": id, "type": "result", "ok": true])
        case "vocabulary":
            guard let dir = request["dir"] as? String, let raw = request["terms"] as? [[String: Any]] else {
                throw HelperError("vocabulary needs dir and terms.")
            }
            let terms = raw.compactMap { t in (t["text"] as? String).map { VocabularyEntry(text: $0, aliases: t["aliases"] as? [String]) } }
            // Detached: this loop holds the main thread while it waits on stdin, so a task tied to it would never run.
            Task.detached {
                do {
                    let count = try await checking.load(id: id, dir: dir, terms: terms)
                    reply(["id": id, "type": "result", "ok": true, "count": count])
                } catch {
                    fail(id, error.localizedDescription)
                }
            }
        case "transcribe":
            guard let pcm = request["pcm"] as? String, let audio = samples(fromBase64: pcm) else {
                throw HelperError("transcribe needs base64 16-bit PCM.")
            }
            let text = try await transcriber.transcribe(audio)
            reply(["id": id, "type": "result", "ok": true, "text": text])
        default:
            throw HelperError("Unknown request: \(op)")
        }
    } catch {
        fail(id, error.localizedDescription)
    }
}
