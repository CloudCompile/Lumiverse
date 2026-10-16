// swift-tools-version:5.5
import PackageDescription

let package = Package(
    name: "tauri-plugin-lumiverse-ios",
    platforms: [.iOS(.v15)],
    products: [.library(name: "tauri-plugin-lumiverse-ios", type: .static, targets: ["tauri-plugin-lumiverse-ios"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-lumiverse-ios", dependencies: [.byName(name: "Tauri")], path: "Sources",
        exclude: ["HighRefreshExperiment.swift"] /* LUMIVERSE_HIGH_REFRESH_SETTINGS */)]
)
