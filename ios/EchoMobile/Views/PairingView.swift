import AVFoundation
import SwiftUI

/// Scan the QR code Echo shows on the Mac (Settings › iPhone › Pair iPhone).
struct PairingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var camera = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var problem: String?
    @State private var paired: Pairing?
    /// Called after pairing succeeds, instead of closing (onboarding moves on to the next step).
    var onPaired: (() -> Void)?

    var body: some View {
        NavigationStack {
            VStack(spacing: 22) {
                if let paired {
                    Spacer()
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 56))
                        .foregroundStyle(.green)
                        .symbolEffect(.bounce, value: paired)
                    Text("Paired with \(paired.macName)").font(.title3.weight(.semibold))
                    Text("Recordings will go to this Mac whenever you’re both on the same Wi-Fi.")
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        if let onPaired { onPaired() } else { dismiss() }
                    } label: {
                        Text("Done").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                } else {
                    Text("On your Mac, open **Echo › Settings**, find **iPhone** and click **Pair iPhone**. Then point this camera at the code.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    scanner
                        .aspectRatio(1, contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(.quaternary, lineWidth: 1))
                    if let problem {
                        Label(problem, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                    Spacer()
                }
            }
            .padding(24)
            .navigationTitle("Pair with Your Mac")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if paired == nil {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                }
            }
            .task {
                if camera == .notDetermined {
                    _ = await AVCaptureDevice.requestAccess(for: .video)
                    camera = AVCaptureDevice.authorizationStatus(for: .video)
                }
            }
        }
    }

    @ViewBuilder private var scanner: some View {
        switch camera {
        case .authorized where AVCaptureDevice.default(for: .video) != nil:
            QRScanner { code in scanned(code) }
        case .authorized:
            placeholder("This device has no camera.", settings: false)
        case .notDetermined:
            placeholder("", settings: false)
        default:
            placeholder("Echo needs the camera to scan the pairing code.", settings: true)
        }
    }

    private func placeholder(_ text: String, settings: Bool) -> some View {
        ZStack {
            Rectangle().fill(.quaternary)
            VStack(spacing: 12) {
                Image(systemName: "camera").font(.largeTitle).foregroundStyle(.secondary)
                if !text.isEmpty { Text(text).font(.subheadline).multilineTextAlignment(.center) }
                if settings {
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }
                }
            }
            .padding()
        }
    }

    private func scanned(_ code: String) {
        guard paired == nil else { return }
        guard let pairing = Pairing(code: code) else {
            problem = "That isn’t an Echo pairing code."
            return
        }
        do {
            try model.link.pair(with: pairing)
            model.greetMac()
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            withAnimation { paired = pairing }
        } catch {
            problem = "Couldn’t save the pairing: \(error.localizedDescription)"
        }
    }
}

/// Camera preview that reports the first QR code it sees.
struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        ScannerController(onCode: onCode)
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        private let session = AVCaptureSession()
        private let onCode: (String) -> Void
        private var preview: AVCaptureVideoPreviewLayer?

        init(onCode: @escaping (String) -> Void) {
            self.onCode = onCode
            super.init(nibName: nil, bundle: nil)
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let preview = AVCaptureVideoPreviewLayer(session: session)
            preview.videoGravity = .resizeAspectFill
            view.layer.addSublayer(preview)
            self.preview = preview
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            let session = session
            DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            let session = session
            DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
        }

        nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard let code = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
            MainActor.assumeIsolated { onCode(code) }
        }
    }
}
