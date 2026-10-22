#if DEBUG
    import Foundation

    /// Simulator testing only, never in release builds. Launch with environment variables
    /// (`SIMCTL_CHILD_<name>=… xcrun simctl launch …`):
    ///   ECHO_PAIR_URL   pair with the given echo://pair link, as if its QR code were scanned
    ///   ECHO_DEMO_MEMO  add a transcribed recording with this text, ready to send
    ///   ECHO_DEMO_SENT=<n>  add n receipts for recordings sent to the Mac earlier today
    ///   ECHO_OPEN_MEMO=1  open the newest recording's sheet
    ///   ECHO_START_RECORDING=1  start recording straight away, to check the Live Activity
    ///   ECHO_SKIP_ONBOARDING=1
    ///   ECHO_LOCK_NO_PROMPT=1  stay locked without asking for Face ID, to check what the lock covers
    ///   ECHO_FAKE_UNLOCK=1  never prompt for Face ID; tapping Unlock just unlocks (the simulator can't do Face ID)
    ///   ECHO_NO_LOCK=1  turn the Face ID lock off (read by AppLock, which starts before this)
    @MainActor
    enum DebugHooks {
        static func apply(to model: AppModel) {
            let env = ProcessInfo.processInfo.environment
            if env["ECHO_SKIP_ONBOARDING"] == "1" { model.onboarded = true }
            if let code = env["ECHO_PAIR_URL"], let pairing = Pairing(code: code) {
                try? model.link.pair(with: pairing)
                model.greetMac()
            }
            if let text = env["ECHO_DEMO_MEMO"] {
                for (i, line) in text.components(separatedBy: "|").enumerated() {
                    let memo = Memo(id: UUID(), recordedAt: Date().addingTimeInterval(Double(-3600 * (i + 1))), duration: Double(180 + 97 * i), phase: .ready, transcript: line)
                    try? model.store.save(memo)
                }
            }
            if let n = env["ECHO_DEMO_SENT"].flatMap(Int.init) {
                let day = Calendar.current.startOfDay(for: Date())
                for i in 0..<n {
                    var memo = Memo(id: UUID(), recordedAt: day.addingTimeInterval(Double(9 * 3600 + 3000 * i)), duration: Double(140 + 61 * i), phase: .sent)
                    memo.sentAt = memo.recordedAt.addingTimeInterval(300)
                    memo.sentTo = "MacBook Pro"
                    try? model.store.save(memo)
                }
            }
            if env["ECHO_OPEN_MEMO"] == "1" { model.debugOpenMemo = model.store.memos.first?.id }
            if env["ECHO_START_RECORDING"] == "1" { Task { await model.startRecording() } }
        }
    }
#endif
