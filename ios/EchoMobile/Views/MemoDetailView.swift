import SwiftUI

/// A look at one recording before it goes: enough to check the client's name was
/// said. Notes are reviewed and finished on the Mac, so there's no editing here.
struct MemoDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let memoID: UUID
    @State private var confirmDelete = false

    var body: some View {
        NavigationStack {
            Group {
                if let memo = model.store.memos.first(where: { $0.id == memoID }) {
                    content(memo)
                } else {
                    ContentUnavailableView("Recording deleted", systemImage: "trash")
                }
            }
            .navigationTitle("Recording")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func content(_ memo: Memo) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 6) {
                    Text(memo.recordedAt.friendly)
                    Text("·")
                    Text(memo.duration.clock).monospacedDigit()
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)

                if let transcript = memo.transcript {
                    Text(transcript)
                        .font(.body)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else if memo.phase == .failed {
                    Label(memo.problem ?? "Couldn’t transcribe this recording.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                } else {
                    Label(model.transcribingID == memo.id ? "Transcribing on this iPhone…" : "Waiting to be transcribed.", systemImage: "waveform")
                        .foregroundStyle(.secondary)
                }

                VStack(spacing: 10) {
                    if memo.phase == .failed {
                        Button {
                            model.retry(memo)
                        } label: {
                            Label("Try Again", systemImage: "arrow.clockwise").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                    }
                    if memo.phase == .ready && model.link.canSend {
                        Button {
                            model.sendWaiting()
                        } label: {
                            Label("Send to \(model.link.macName)", systemImage: "arrow.up.circle").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                    }
                    Button(role: .destructive) {
                        confirmDelete = true
                    } label: {
                        Label("Delete Recording", systemImage: "trash").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                }
                .padding(.top, 8)
            }
            .padding(20)
        }
        .confirmationDialog("Delete this recording?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                model.delete(memo)
                dismiss()
            }
        } message: {
            Text("It hasn’t reached your Mac yet, so it will be gone for good.")
        }
    }
}
