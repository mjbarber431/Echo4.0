import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var showPairing = false
    @State private var confirmUnpair = false

    var body: some View {
        @Bindable var lock = model.lock
        NavigationStack {
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
                } header: {
                    Text("Mac")
                } footer: {
                    Text("Recordings go straight to Echo on your Mac over your Wi-Fi, encrypted with a key only your Mac and this iPhone have. Nothing goes through the internet.")
                }

                Section {
                    Toggle("Require \(lock.biometryName)", isOn: $lock.enabled)
                } header: {
                    Text("Privacy")
                } footer: {
                    Text("Audio is deleted as soon as it’s transcribed. Transcripts are stored encrypted on this iPhone only until your Mac has them. Nothing is backed up to iCloud.")
                }

                Section {
                    SpeechModelRow()
                } header: {
                    Text("Transcription")
                } footer: {
                    Text("Parakeet, the speech model Echo uses on your Mac, runs on this iPhone. Audio never leaves it.")
                }

                Section("Tips") {
                    Label("Say the client’s name first. Your Mac suggests the client from it, and you confirm before the note is written.", systemImage: "person.wave.2")
                    Label("Locking your iPhone doesn’t stop a recording. A phone call pauses it.", systemImage: "lock")
                    Label("Open Echo when you get home so it can send. iOS doesn’t let it reach your Mac while it’s closed.", systemImage: "house")
                }
                .font(.subheadline)
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .sheet(isPresented: $showPairing) { PairingView() }
            .confirmationDialog("Unpair from \(model.link.macName)?", isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) { model.link.unpair() }
            } message: {
                Text("Recordings will wait on this iPhone until you pair again.")
            }
        }
    }
}

struct SpeechModelRow: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.speech.status {
        case .ready:
            LabeledContent("Speech model") { Label("Ready", systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
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
                Button("Try Again") { model.speech.prepare() }
            }
        }
    }
}
