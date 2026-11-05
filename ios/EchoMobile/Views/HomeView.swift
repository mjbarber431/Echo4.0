import SwiftUI

/// The only main screen: where the Mac link stands, what's waiting to go to it,
/// and a big record button within thumb's reach.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var showSettings = false
    @State private var showPairing = false
    @State private var selected: Memo?

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            List {
                Section {
                    LinkStatusRow(onPair: { showPairing = true })
                        .listRowBackground(statusBackground)
                }

                if model.store.waiting.isEmpty && model.store.sentToday.isEmpty {
                    Section {
                        EmptyState()
                    }
                    .listRowBackground(Color.clear)
                }

                if !model.store.waiting.isEmpty {
                    Section {
                        ForEach(model.store.waiting) { memo in
                            Button { selected = memo } label: { MemoRow(memo: memo) }
                                .tint(.primary)
                        }
                    } header: {
                        Text("On this iPhone")
                    } footer: {
                        Text("Recordings stay here until \(model.link.macName) has them, then they’re deleted from this iPhone.")
                    }
                }

                if !model.store.sentToday.isEmpty {
                    Section("Today") {
                        SentTodayCard(memos: model.store.sentToday)
                    }
                }
            }
            .navigationTitle("Echo")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("Settings")
                }
            }
            .safeAreaInset(edge: .bottom) { RecordBar() }
            .refreshable { model.becameActive() }
            #if DEBUG
                .onAppear {
                    if let id = model.debugOpenMemo { selected = model.store.memos.first { $0.id == id } }
                }
            #endif
            .sheet(item: $selected) { memo in MemoDetailView(memoID: memo.id) }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .sheet(isPresented: $showPairing) { PairingView() }
            .fullScreenCover(isPresented: Binding(get: { model.recordingID != nil || model.handsFree.isActive }, set: { _ in })) {
                if model.handsFree.isActive { HandsFreeView() } else { RecordingView() }
            }
            .alert("Echo", isPresented: Binding(get: { model.alert != nil }, set: { if !$0 { model.alert = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(model.alert ?? "")
            }
        }
    }

    /// Echo's green, as on Settings, unless something's wrong with the link.
    @ViewBuilder private var statusBackground: some View {
        if case .blocked = model.link.state {
            Rectangle().fill(Color.orange.opacity(0.14))
        } else {
            Rectangle().fill(.echoBackground)
        }
    }
}

private struct EmptyState: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "waveform")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(.tertiary)
            Text("No recordings waiting")
                .font(.headline)
            Text("After a session, tap Record and start with the client’s name. Echo on your Mac takes it from there.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
    }
}

/// One card for everything sent today: how many, how much, and when, instead of a
/// receipt per recording that all say the same thing.
private struct SentTodayCard: View {
    @Environment(AppModel.self) private var model
    let memos: [Memo]

    var body: some View {
        let total = memos.reduce(0) { $0 + $1.duration }
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 14) {
                ZStack {
                    Circle().fill(Color.green.opacity(0.14))
                    Image(systemName: "checkmark").font(.system(size: 17, weight: .bold)).foregroundStyle(.green)
                }
                .frame(width: 44, height: 44)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("\(memos.count)")
                            .font(.system(.largeTitle, design: .rounded).weight(.bold))
                            .contentTransition(.numericText())
                        Text(memos.count == 1 ? "recording sent" : "recordings sent")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    Text("\(total.spoken) in all · on \(mac)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            DayTimeline(times: memos.map(\.recordedAt))
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .animation(.snappy, value: memos.count)
    }

    /// The Mac they went to; they all go to the paired one, so the first receipt's name will do.
    private var mac: String { memos.first?.sentTo ?? model.link.macName }
}

/// The working day as a line, with a dot for when each recording was made.
private struct DayTimeline: View {
    let times: [Date]

    var body: some View {
        let (start, end) = range
        VStack(spacing: 6) {
            GeometryReader { geo in
                let span = end.timeIntervalSince(start)
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.15)).frame(height: 6)
                    ForEach(times, id: \.self) { time in
                        Circle()
                            .fill(Color.green)
                            .overlay(Circle().stroke(Color(.secondarySystemGroupedBackground), lineWidth: 2))
                            .frame(width: 12, height: 12)
                            .offset(x: (geo.size.width - 12) * time.timeIntervalSince(start) / span)
                    }
                }
                .frame(maxHeight: .infinity)
            }
            .frame(height: 14)
            HStack {
                Text(start, format: .dateTime.hour())
                Spacer()
                Text(end, format: .dateTime.hour())
            }
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        .accessibilityHidden(true)
    }

    /// 8 AM to 6 PM, stretched to whole hours around anything recorded outside that.
    private var range: (Date, Date) {
        let cal = Calendar.current
        let day = cal.startOfDay(for: Date())
        var start = cal.date(byAdding: .hour, value: 8, to: day)!
        var end = cal.date(byAdding: .hour, value: 18, to: day)!
        if let first = times.min(), first < start {
            start = cal.dateInterval(of: .hour, for: first)?.start ?? first
        }
        if let last = times.max(), last > end {
            end = cal.dateInterval(of: .hour, for: last)?.end ?? last
        }
        return (start, end)
    }
}

/// What the record button starts.
private enum RecordMode: Int, CaseIterable, Identifiable {
    case plain, handsFree

    var id: Int { rawValue }
    var title: String { self == .plain ? "Record" : "Hands-free" }
    var icon: String { self == .plain ? "mic.fill" : "headphones" }
}

/// The record button, pinned to the bottom of the screen. With hands-free turned on in Settings
/// it swipes between the two modes: the one button turns over under the finger like a coin, with
/// the other mode on its back, and the name below says which is live. One gesture does the tap and
/// the swipe, so a swipe can never start recording.
private struct RecordBar: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var starting = false
    @State private var dragX: CGFloat = 0
    @State private var pressed = false

    /// How far a finger travels to turn the button all the way over.
    private static let swipeDistance: CGFloat = 120
    private static let labelTravel: CGFloat = 36
    private static let dialWidth: CGFloat = 280
    private static let buttonSize: CGFloat = 78
    /// Further than this and a touch is a swipe, not a tap.
    private static let tapSlop: CGFloat = 10

    private var modes: [RecordMode] { model.handsFreeSettings.enabled ? RecordMode.allCases : [.plain] }
    private var selected: RecordMode { model.handsFreeSettings.enabled && model.handsFreeSettings.armed ? .handsFree : .plain }
    /// How far along the modes the finger has taken us: 0 is plain, 1 is hands-free.
    private var page: CGFloat { CGFloat(selected.rawValue) - dragX / Self.swipeDistance }
    private var settling: Animation { reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.38, dampingFraction: 0.72) }

    var body: some View {
        VStack(spacing: 8) {
            dial
            if modes.count > 1 { names }

            Text(hint)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .contentTransition(.opacity)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 8)
        .background {
            UnevenRoundedRectangle(topLeadingRadius: 28, topTrailingRadius: 28)
                .fill(.bar)
                .shadow(color: .black.opacity(0.07), radius: 14, y: -4)
                .ignoresSafeArea(edges: .bottom)
        }
        .animation(.snappy, value: model.recordsHandsFree)
        .animation(.snappy, value: model.handsFreeSettings.enabled)
    }

    private var hint: String {
        let client = "Start with the client’s name"
        guard selected == .handsFree else { return client }
        switch model.commandModel.status {
        case .ready: return model.commandModel.warming ? "Getting voice commands ready…" : "Say “Okay, new note” between clients"
        case .downloading: return "Downloading voice commands…"
        case .notDownloaded, .failed: return "Finish setting up in Settings › Hands-free"
        }
    }

    private var dial: some View {
        ZStack {
            if !reduceMotion {
                Circle()
                    .stroke(Color.accentColor, lineWidth: 2)
                    .frame(width: Self.buttonSize, height: Self.buttonSize)
                    .keyframeAnimator(initialValue: Ripple(), trigger: selected) { ring, value in
                        ring.scaleEffect(value.scale).opacity(value.opacity)
                    } keyframes: { _ in
                        KeyframeTrack(\.scale) {
                            LinearKeyframe(1, duration: 0.12)
                            CubicKeyframe(1.6, duration: 0.48)
                        }
                        KeyframeTrack(\.opacity) {
                            LinearKeyframe(0.7, duration: 0.12)
                            CubicKeyframe(0, duration: 0.48)
                        }
                    }
            }
            RecordCoin(page: page, reduceMotion: reduceMotion, waiting: model.commandModel.status != .ready)
                .frame(width: Self.buttonSize, height: Self.buttonSize)
                .scaleEffect(pressed ? 0.92 : 1)
                .animation(.spring(response: 0.25, dampingFraction: 0.6), value: pressed)
                .offset(x: dragX * 0.12) // Enough to feel held, without leaving the middle.
        }
        .frame(width: Self.dialWidth, height: Self.buttonSize + 8)
        .contentShape(Rectangle())
        .gesture(touch)
        .sensoryFeedback(.impact(weight: .medium), trigger: selected)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Record")
        .accessibilityValue(modes.count > 1 ? selected.title : "")
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(selected == .handsFree ? "Starts recording notes you control by voice." : "Starts recording a session summary. Say the client’s name first.")
        .accessibilityAction { start() }
        .accessibilityActions {
            if modes.count > 1 {
                let other = selected == .plain ? RecordMode.handsFree : .plain
                Button("Switch to \(other.title)") { select(other) }
            }
        }
    }

    private var names: some View {
        ZStack {
            ForEach(modes) { mode in
                let distance = CGFloat(mode.rawValue) - page
                Text(mode.title)
                    .font(.footnote.weight(.semibold))
                    .opacity(max(0, 1 - abs(distance) * 1.6)) // Gone before it's halfway, so the two never overlap.
                    .offset(x: distance * Self.labelTravel)
            }
        }
        .frame(height: 18)
        .accessibilityHidden(true)
    }

    private var touch: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                let x = value.translation.width
                let isTap = abs(x) < Self.tapSlop && abs(value.translation.height) < Self.tapSlop
                pressed = isTap && onButton(value.startLocation.x)
                guard !isTap, !starting else { return }
                // Past the last mode it only gives a little, so you can feel the end.
                let target = selected.rawValue + (x < 0 ? 1 : -1)
                dragX = modes.indices.contains(target) ? max(-Self.swipeDistance, min(x, Self.swipeDistance)) : x * 0.2
            }
            .onEnded { value in
                pressed = false
                let moved = max(abs(value.translation.width), abs(value.translation.height))
                if moved < Self.tapSlop {
                    if onButton(value.location.x) { start() }
                } else {
                    settle(flungTo: value.predictedEndTranslation.width)
                }
            }
    }

    private func onButton(_ x: CGFloat) -> Bool {
        abs(x - Self.dialWidth / 2) <= Self.buttonSize / 2 + 6
    }

    private func settle(flungTo x: CGFloat) {
        let step = x < -Self.swipeDistance / 2 ? 1 : x > Self.swipeDistance / 2 ? -1 : 0
        select(RecordMode(rawValue: selected.rawValue + step).flatMap { modes.contains($0) ? $0 : nil } ?? selected)
    }

    private func select(_ mode: RecordMode) {
        withAnimation(settling) {
            model.handsFreeSettings.armed = mode == .handsFree
            dragX = 0
        }
        if mode == .handsFree { model.commandModel.warmUp() }
    }

    private func start() {
        guard !starting else { return }
        // The hint says what it's waiting for.
        guard selected == .plain || model.recordsHandsFree else {
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
            return
        }
        starting = true
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        Task {
            if selected == .handsFree {
                await model.startHandsFree()
            } else {
                await model.startRecording()
            }
            starting = false
        }
    }
}

/// The button itself: plain on one face, hands-free on the other. Animatable so a release carries on
/// through the turn, showing the right face at each moment, rather than jumping to the end.
private struct RecordCoin: View, Animatable {
    var page: CGFloat
    let reduceMotion: Bool
    /// Hands-free can't start yet, so its face is dimmed.
    let waiting: Bool

    nonisolated var animatableData: CGFloat {
        get { page }
        set { page = newValue }
    }

    var body: some View {
        if reduceMotion {
            ZStack {
                face(.plain).opacity(1 - page)
                face(.handsFree).opacity(page)
            }
        } else {
            let shown: RecordMode = page < 0.5 ? .plain : .handsFree
            // Halfway it's edge-on. The back face is turned a further half so it doesn't read mirrored.
            let angle = -page * 180 + (shown == .plain ? 0 : 180)
            face(shown)
                .scaleEffect(1 - 0.1 * sin(.pi * min(max(page, 0), 1)))
                .rotation3DEffect(.degrees(angle), axis: (x: 0, y: 1, z: 0), perspective: 0.45)
        }
    }

    private func face(_ mode: RecordMode) -> some View {
        ZStack {
            Circle()
                .fill(mode == .plain ? AnyShapeStyle(Color.accentColor.gradient) : AnyShapeStyle(Color.echoDeep.gradient))
                .shadow(color: .accentColor.opacity(0.35), radius: 12, y: 6)
            Image(systemName: mode.icon)
                .font(.system(size: 30, weight: .semibold))
                .foregroundStyle(.white)
        }
        .opacity(mode == .handsFree && waiting ? 0.5 : 1)
    }
}

private struct Ripple {
    var scale: CGFloat = 1
    var opacity: Double = 0
}

struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.6), value: configuration.isPressed)
    }
}

/// Where things stand with the Mac, in one line, with the one action that helps.
struct LinkStatusRow: View {
    @Environment(AppModel.self) private var model
    var onPair: () -> Void

    var body: some View {
        let link = model.link
        let waiting = model.store.readyToSend.count
        switch link.state {
        case .unpaired:
            Button(action: onPair) {
                row(icon: "qrcode.viewfinder", title: "Pair with your Mac", detail: "On your Mac, open Echo › Settings › iPhone, then scan the code.", chevron: true)
            }
            .tint(.primary)
        case .searching:
            row(icon: "laptopcomputer", title: "Looking for \(link.macName)…", detail: waiting > 0 ? "\(count(waiting)) will send when this iPhone and your Mac are on the same Wi-Fi with Echo open." : "Recordings send when this iPhone and your Mac are on the same Wi-Fi with Echo open.", busy: true)
        case .found:
            row(icon: "checkmark", title: "Connected to \(link.macName)", detail: waiting > 0 ? "\(count(waiting)) waiting to send." : "Everything’s on your Mac.")
        case .sending:
            row(icon: "arrow.up", title: "Sending to \(link.macName)…", detail: "\(count(waiting)).", busy: true)
        case let .blocked(reason):
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            } label: {
                row(icon: "exclamationmark.triangle.fill", title: "Can’t reach \(link.macName)", detail: reason, chevron: reason.contains("Settings ›"), warning: true)
            }
            .tint(.primary)
        }
    }

    private func count(_ n: Int) -> String { n == 1 ? "1 recording" : "\(n) recordings" }

    /// White on Echo's green, or plain text on orange when something needs fixing.
    private func row(icon: String, title: String, detail: String, busy: Bool = false, chevron: Bool = false, warning: Bool = false) -> some View {
        HStack(spacing: 14) {
            ZStack {
                Circle().fill(warning ? AnyShapeStyle(Color.orange.opacity(0.2)) : AnyShapeStyle(.white.opacity(0.16)))
                if busy {
                    ProgressView().controlSize(.small).tint(.white)
                } else {
                    Image(systemName: icon).font(.system(size: 15, weight: .semibold)).foregroundStyle(warning ? .orange : .white)
                }
            }
            .frame(width: 36, height: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(warning ? .primary : Color.white)
                Text(detail).font(.footnote).foregroundStyle(warning ? AnyShapeStyle(.secondary) : AnyShapeStyle(.white.opacity(0.75)))
            }
            Spacer(minLength: 0)
            if chevron {
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold))
                    .foregroundStyle(warning ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.white.opacity(0.6)))
            }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }
}

struct MemoRow: View {
    @Environment(AppModel.self) private var model
    let memo: Memo

    var body: some View {
        HStack(spacing: 14) {
            icon.frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.body)
                    .lineLimit(2)
                    .foregroundStyle(memo.phase == .sent ? .secondary : .primary)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(memo.phase == .failed ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 3)
    }

    private var transcribing: Bool { model.transcribingID == memo.id }

    private var title: String {
        switch memo.phase {
        case .sent: "Sent to \(memo.sentTo ?? model.link.macName)"
        case .ready: memo.preview ?? "Recording"
        case .recorded: transcribing ? "Transcribing…" : "Recording"
        case .failed: "Recording"
        }
    }

    private var detail: String {
        let when = "\(memo.recordedAt.friendly) · \(memo.duration.spoken)"
        switch memo.phase {
        case .sent: return "Recorded \(when)"
        case .ready: return when
        case .failed: return memo.problem ?? "Couldn’t transcribe."
        case .recorded:
            if transcribing { return when }
            switch model.speech.status {
            case .ready: return "\(when) · waiting to transcribe"
            case .notDownloaded: return "\(when) · download the speech model in Settings"
            case .downloading, .loading: return "\(when) · waiting for the speech model"
            case .failed: return "\(when) · the speech model needs attention in Settings"
            }
        }
    }

    @ViewBuilder private var icon: some View {
        switch memo.phase {
        case .sent:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).font(.title3)
        case .ready:
            Image(systemName: "arrow.up.circle").foregroundStyle(Color.accentColor).font(.title3)
        case .failed:
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange).font(.title3)
        case .recorded:
            if transcribing {
                Image(systemName: "waveform").foregroundStyle(Color.accentColor).font(.title3).symbolEffect(.variableColor.iterative)
            } else {
                Image(systemName: "waveform").foregroundStyle(.secondary).font(.title3)
            }
        }
    }
}
