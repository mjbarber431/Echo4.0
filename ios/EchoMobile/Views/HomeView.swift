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

/// The record button, pinned to the bottom of the screen. With hands-free turned on in Settings,
/// a switch under it chooses what the button starts.
private struct RecordBar: View {
    @Environment(AppModel.self) private var model
    @State private var starting = false

    var body: some View {
        VStack(spacing: 10) {
            recordButton

            Text(hint)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .contentTransition(.opacity)

            if model.handsFreeSettings.enabled { HandsFreeSwitch() }
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
    }

    private var hint: String {
        guard model.handsFreeSettings.enabled, model.handsFreeSettings.armed else { return "Start with the client’s name" }
        switch model.commandModel.status {
        case .ready: return "Say “Okay, new note” between clients"
        case .downloading: return "Downloading voice commands…"
        case .notDownloaded, .failed: return "Finish setting up in Settings › Hands-free"
        }
    }

    private var recordButton: some View {
        Button {
            guard !starting else { return }
            starting = true
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            Task {
                if model.recordsHandsFree {
                    await model.startHandsFree()
                } else {
                    await model.startRecording()
                }
                starting = false
            }
        } label: {
            ZStack {
                Circle()
                    .fill(Color.accentColor.gradient)
                    .shadow(color: .accentColor.opacity(0.35), radius: 12, y: 6)
                Image(systemName: model.recordsHandsFree ? "headphones" : "mic.fill")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(.white)
                    .contentTransition(.symbolEffect(.replace))
            }
            .frame(width: 78, height: 78)
        }
        .buttonStyle(PressableStyle())
        .accessibilityLabel("Record")
        .accessibilityHint(model.recordsHandsFree ? "Starts recording notes you control by voice." : "Starts recording a session summary. Say the client’s name first.")
    }
}

private struct HandsFreeSwitch: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let ready = model.commandModel.status == .ready
        HStack(spacing: 10) {
            Image(systemName: "headphones")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .accessibilityHidden(true)
            Text("Hands-free")
                .font(.subheadline.weight(.medium))
                .accessibilityHidden(true)
            Toggle("Hands-free", isOn: Binding(
                get: { model.recordsHandsFree },
                set: { model.handsFreeSettings.armed = $0 }
            ))
            .labelsHidden()
            .disabled(!ready)
            .accessibilityHint("When on, Record starts notes you control by voice.")
        }
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .padding(.vertical, 6)
        .background(Color(.tertiarySystemFill), in: Capsule())
        .opacity(ready ? 1 : 0.5)
    }
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
