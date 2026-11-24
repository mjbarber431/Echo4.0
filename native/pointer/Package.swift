// swift-tools-version: 6.0
import PackageDescription

// Echo's hands and eyes for placing notes in an EHR (src/main/placer.ts). Electron's main
// process runs it as a child process and talks JSON lines over stdin/stdout: it captures the
// EHR's Chrome window and nothing else, and clicks, scrolls and presses keys inside it.
let package = Package(
    name: "EchoPointer",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "EchoPointer", swiftSettings: [.swiftLanguageMode(.v5)])
    ]
)
