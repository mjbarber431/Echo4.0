// swift-tools-version: 6.0
import PackageDescription

// Echo's local speech-to-text helper. Electron's main process runs it as a child
// process and talks to it over stdin/stdout (see Sources/EchoTranscriber/main.swift).
let package = Package(
    name: "EchoTranscriber",
    platforms: [.macOS(.v14)],
    dependencies: [
        // Pinned to an exact release: it runs on clinical audio.
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.7")
    ],
    targets: [
        .executableTarget(
            name: "EchoTranscriber",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
        )
    ]
)
