// swift-tools-version: 6.0
import PackageDescription

// All app logic lives here, UI-free, so `swift test` runs on macOS without a
// simulator — the same discipline as the site's pure lib modules.
let package = Package(
    name: "JobsKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "JobsKit", targets: ["JobsKit"])
    ],
    targets: [
        .target(
            name: "JobsKit",
            resources: [.copy("Resources")]
        ),
        .testTarget(
            name: "JobsKitTests",
            dependencies: ["JobsKit"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
