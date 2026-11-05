import Foundation

/// Holds the newest few seconds of audio back from the file, so a spoken command can be taken
/// out before it's ever written. A command is only recognised after it's been said; by then
/// its audio is still in here.
///
/// Positions are sample counts from the start of the session, at 16 kHz.
struct NoteCutter: Sendable {
    static let sampleRate = 16_000

    enum Step: Sendable, Equatable {
        /// Audio that's ready to go to the current note.
        case audio([Float])
        /// The audio stream has reached this cut: act on it now, so what's before and after land in the right notes.
        case cut(Int)
    }

    private struct Cut: Sendable {
        let id: Int
        let from: Int
        let to: Int
    }

    private let holdSamples: Int
    private var held: [Float] = []
    /// The position of `held[0]`.
    private var start = 0
    private var skipUntil = 0
    private var cuts: [Cut] = []

    init(holdSeconds: Double) {
        holdSamples = Int(holdSeconds * Double(Self.sampleRate))
    }

    /// The position just after the newest audio.
    var end: Int { start + held.count }

    mutating func append(_ samples: [Float]) -> [Step] {
        held += samples
        return release(upTo: end - holdSamples)
    }

    /// Removes `from..<to` and reports `.cut(id)` when the stream gets there. `to` can be in the
    /// future. If `from` has already gone by, the cut happens at the oldest audio still held.
    mutating func cut(id: Int, from: Int, to: Int) {
        cuts.append(Cut(id: id, from: from, to: to))
        cuts.sort { $0.from < $1.from }
    }

    /// Lets go of everything, at the end of the session.
    mutating func flush() -> [Step] {
        release(upTo: .max)
    }

    /// Where speech most likely starts, looking back from `position`. Token times are late by
    /// 0 to 0.6 s, so cutting right at one would leave half of "Okay" in the note.
    /// This finds the quiet just before the word: the latest 20 ms slice, in the last
    /// `withinMs`, that's close to the quietest there.
    func quietPoint(before position: Int, withinMs: Int = 800) -> Int {
        let frame = Self.sampleRate / 50
        let top = min(position, end)
        let bottom = max(start, top - withinMs * Self.sampleRate / 1000)
        guard top - bottom >= frame else { return top }
        var energies: [(position: Int, energy: Float)] = []
        var at = top - frame
        while at >= bottom {
            let slice = held[(at - start)..<(at - start + frame)]
            energies.append((at, slice.reduce(0) { $0 + $1 * $1 } / Float(frame)))
            at -= frame
        }
        let quietest = energies.map(\.energy).min() ?? 0
        let threshold = max(quietest * 2.5, 1e-6)
        // Newest first, so the first quiet slice is the one right before the word.
        return (energies.first { $0.energy <= threshold }?.position ?? bottom) + frame
    }

    /// Where the speech stops, looking on from `position`: the first quiet slice in the next
    /// `withinMs`. A command's last token can come up to 0.4 s before its sound ends, and by the
    /// time a command is accepted the next note may have started, so this is the safe end of a cut.
    func quietPoint(after position: Int, withinMs: Int = 700) -> Int {
        let frame = Self.sampleRate / 50
        let bottom = max(position, start)
        let top = min(end, bottom + withinMs * Self.sampleRate / 1000)
        guard top - bottom >= frame else { return bottom }
        var energies: [(position: Int, energy: Float)] = []
        var at = bottom
        while at + frame <= top {
            let slice = held[(at - start)..<(at - start + frame)]
            energies.append((at, slice.reduce(0) { $0 + $1 * $1 } / Float(frame)))
            at += frame
        }
        let quietest = energies.map(\.energy).min() ?? 0
        let threshold = max(quietest * 2.5, 1e-6)
        return energies.first { $0.energy <= threshold }?.position ?? top
    }

    private mutating func release(upTo limit: Int) -> [Step] {
        var steps: [Step] = []
        while true {
            let next = cuts.first.map { max($0.from, start) }
            let stop = min(end, limit, next ?? .max)
            if stop > start { emit(upTo: stop, into: &steps) }
            guard let cut = cuts.first, let next, next <= limit else { return steps }
            // `limit` is past the end only for a flush, which runs every cut that's left.
            guard next <= end || limit == .max else { return steps }
            cuts.removeFirst()
            steps.append(.cut(cut.id))
            skipUntil = max(skipUntil, cut.to)
        }
    }

    private mutating func emit(upTo stop: Int, into steps: inout [Step]) {
        let keepFrom = min(max(start, skipUntil), stop)
        if stop > keepFrom { steps.append(.audio(Array(held[(keepFrom - start)..<(stop - start)]))) }
        held.removeFirst(stop - start)
        start = stop
    }
}
