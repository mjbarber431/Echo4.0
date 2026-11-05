import SwiftUI

/// The top level stays short: where things stand with the Mac, then a row per setting.
/// Anything with more than a switch to it has its own page.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var lock = model.lock
        NavigationStack {
            List {
                Section {
                    // The link's own chevron is too dark to see on green, so it's hidden and the card draws one.
                    ZStack {
                        NavigationLink { MacSettingsView() } label: { EmptyView() }.opacity(0)
                        ConnectionCard()
                    }
                    .listRowBackground(Color.echoDeep)
                }

                Section("Recording") {
                    NavigationLink { HandsFreeSettingsView() } label: {
                        SettingRow("Hands-free", icon: "headphones", value: model.handsFreeSettings.enabled ? "On" : "Off")
                    }
                    HStack(spacing: 12) {
                        SettingIcon(name: "waveform")
                        SpeechModelRow()
                    }
                }

                Section {
                    Toggle(isOn: $lock.enabled) {
                        SettingRow("Require \(lock.biometryName)", icon: "faceid")
                    }
                } header: {
                    Text("Privacy")
                } footer: {
                    Text("Audio is deleted as soon as it’s transcribed. Transcripts are stored encrypted on this iPhone only until your Mac has them. Nothing is backed up to iCloud.")
                }

                Section {
                    NavigationLink { TipsView() } label: {
                        SettingRow("Tips for dictating", icon: "lightbulb")
                    }
                } footer: {
                    Text("Echo for iPhone \(Self.version)")
                        .frame(maxWidth: .infinity)
                        .padding(.top, 16)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    private static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }
}

/// A setting's icon and name. Every icon shares Echo's green, so nothing here competes with the card above.
struct SettingRow: View {
    let title: String
    let icon: String
    var value: String?

    init(_ title: String, icon: String, value: String? = nil) {
        self.title = title
        self.icon = icon
        self.value = value
    }

    var body: some View {
        HStack(spacing: 12) {
            SettingIcon(name: icon)
            Text(title)
            if let value {
                Spacer()
                Text(value).foregroundStyle(.secondary)
            }
        }
    }
}

private struct SettingIcon: View {
    let name: String

    var body: some View {
        Image(systemName: name)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(Color.accentColor)
            .frame(width: 30, height: 30)
            .background(Color.accentColor.opacity(0.13), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// Where things stand with the Mac: the one thing on this screen with Echo's own look.
private struct ConnectionCard: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 14) {
            EchoMark(size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline).foregroundStyle(.white)
                Text(detail).font(.footnote).foregroundStyle(.white.opacity(0.75))
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.white.opacity(0.6))
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        model.link.pairing.map { "Paired with \($0.macName)" } ?? "Not paired with a Mac"
    }

    private var detail: String {
        guard model.link.pairing != nil else { return "Pair to send recordings to Echo on your Mac." }
        if let last = model.link.lastContact { return "Last connected \(last.friendly)" }
        return "Recordings send when you’re both on the same Wi-Fi."
    }
}

struct MacSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var showPairing = false
    @State private var confirmUnpair = false

    var body: some View {
        Form {
            Section {
                if let pairing = model.link.pairing {
                    LabeledContent("Paired with", value: pairing.macName)
                    if let last = model.link.lastContact {
                        LabeledContent("Last connected", value: last.friendly)
                    }
                    Button("Send Now") { model.becameActive() }
                        .disabled(!model.link.canSend || model.store.readyToSend.isEmpty)
                    Button("Pair with a Different Mac") { showPairing = true }
                    Button("Unpair", role: .destructive) { confirmUnpair = true }
                } else {
                    Button {
                        showPairing = true
                    } label: {
                        Label("Pair with Your Mac", systemImage: "qrcode.viewfinder")
                    }
                }
            } footer: {
                Text("Recordings go straight to Echo on your Mac over your Wi-Fi, encrypted with a key only your Mac and this iPhone have. Nothing goes through the internet.")
            }
        }
        .navigationTitle("Mac")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showPairing) { PairingView() }
        .confirmationDialog("Unpair from \(model.link.macName)?", isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button("Unpair", role: .destructive) { model.link.unpair() }
        } message: {
            Text("Recordings will wait on this iPhone until you pair again.")
        }
    }
}

struct HandsFreeSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var cues = HandsFreeCues()

    /// What can be said, shown in the order they're likely to be needed.
    private static let commands: [(phrase: String, effect: String)] = [
        ("Echo, new note", "Saves this note and starts the next"),
        ("Echo, pause", "Stops recording but keeps listening"),
        ("Echo, resume", "Carries on with the same note"),
        ("Echo, discard note", "Throws away this note and starts it over"),
        ("Echo, undo", "Takes back a discard, or the last new note for about a minute"),
        ("Echo, status", "Tells you which note you’re on"),
        ("Echo, help", "Reads out the commands"),
        ("Echo, finish", "Saves everything and stops"),
    ]

    var body: some View {
        @Bindable var settings = model.handsFreeSettings
        Form {
            Section {
                Toggle("Use Hands-Free Mode", isOn: $settings.enabled)
            } footer: {
                Text("Dictate several notes in a row without touching your iPhone, on a walk or doing the dishes. A Hands-free switch appears under Record. With it off, Record works as it always has.")
            }

            if settings.enabled {
                Section {
                    CommandModelRow()
                } footer: {
                    Text("Echo listens for commands on this iPhone. What it hears while listening isn’t kept, and the commands it recognizes are left out of your notes.")
                }

                Section("Confirmation") {
                    Picker("Confirmation", selection: $settings.confirmation) {
                        ForEach(HandsFreeSettings.Confirmation.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    if settings.confirmation == .voice {
                        ForEach(HandsFreeSettings.Voice.allCases) { voice in
                            Button {
                                settings.voice = voice
                                sample()
                            } label: {
                                HStack {
                                    Text(voice.label).foregroundStyle(Color.primary)
                                    Spacer()
                                    if settings.voice == voice {
                                        Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(Color.accentColor)
                                    }
                                }
                            }
                        }
                    }
                    Button("Play a Sample") { sample() }
                }

                Section {
                    ForEach(Self.commands, id: \.phrase) { command in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("“\(command.phrase)”").fontWeight(.medium)
                            Text(command.effect).font(.footnote).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 1)
                    }
                } header: {
                    Text("What you can say")
                } footer: {
                    Text("Pause for a moment after a command. No confirmation means Echo didn’t hear it, so say it again.")
                }
            }
        }
        .navigationTitle("Hands-free")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: settings.enabled, initial: true) { _, enabled in
            if enabled { model.commandModel.prepare() }
        }
    }

    private func sample() {
        let settings = model.handsFreeSettings
        cues.preview(style: settings.confirmation, voice: settings.voice)
    }
}

/// The listening model's download, started by turning hands-free on.
private struct CommandModelRow: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.commandModel.status {
        case .ready:
            ReadyRow(title: "Voice commands")
        case let .downloading(fraction):
            VStack(alignment: .leading, spacing: 8) {
                LabeledContent("Downloading voice commands", value: fraction.formatted(.percent.precision(.fractionLength(0))))
                ProgressView(value: fraction)
            }
        case .notDownloaded:
            Button {
                model.commandModel.prepare()
            } label: {
                LabeledContent("Download voice commands", value: CommandModel.sizeLabel)
            }
        case let .failed(message):
            VStack(alignment: .leading, spacing: 6) {
                Text("Voice commands couldn’t download").foregroundStyle(.orange)
                Text(message).font(.footnote).foregroundStyle(.secondary)
                Button("Try Again") { model.commandModel.prepare() }
            }
        }
    }
}

private struct ReadyRow: View {
    let title: String

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            Label("Ready", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        }
    }
}

private struct TipsView: View {
    var body: some View {
        List {
            Label("Say the client’s name first. Your Mac suggests the client from it, and you confirm before the note is written.", systemImage: "person.wave.2")
            Label("Locking your iPhone doesn’t stop a recording. A phone call pauses it.", systemImage: "lock")
            Label("Open Echo when you get home so it can send. iOS doesn’t let it reach your Mac while it’s closed.", systemImage: "house")
        }
        .font(.subheadline)
        .navigationTitle("Tips")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct SpeechModelRow: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.speech.status {
        case .ready:
            ReadyRow(title: "Speech model")
        case .loading:
            LabeledContent("Speech model") { HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Loading…") } }
        case let .downloading(fraction):
            VStack(alignment: .leading, spacing: 8) {
                LabeledContent("Downloading speech model", value: fraction.formatted(.percent.precision(.fractionLength(0))))
                ProgressView(value: fraction)
            }
        case .notDownloaded:
            Button {
                model.speech.prepare()
            } label: {
                LabeledContent("Download speech model", value: "450 MB")
            }
        case let .failed(message):
            VStack(alignment: .leading, spacing: 6) {
                Text("The speech model couldn’t load").foregroundStyle(.orange)
                Text(message).font(.footnote).foregroundStyle(.secondary)
                Button("Try Again") { model.speech.prepare(repair: true) }
            }
        }
    }
}
