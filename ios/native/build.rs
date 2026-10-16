fn main() {
    // Native controls are owned by UIKit. Remote pages receive no plugin commands.
    let mut builder = tauri_plugin::Builder::new(&[]);
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        // A separate package per Cargo feature set avoids SwiftPM manifest-cache
        // reuse across ordinary and experimental builds. Never mutate sources.
        let source = std::path::Path::new("ios");
        let package = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("ios");
        let experimental = std::env::var_os("CARGO_FEATURE_EXPERIMENTAL_HIGH_REFRESH").is_some();
        println!("cargo:rerun-if-changed=ios/Package.swift");
        println!("cargo:rerun-if-changed=ios/Sources");
        std::fs::create_dir_all(package.join("Sources")).unwrap();
        let mut manifest = std::fs::read_to_string(source.join("Package.swift")).unwrap();
        let mut defines = Vec::new();
        if experimental {
            manifest = manifest.replace("exclude: [\"HighRefreshExperiment.swift\"]", "exclude: []");
            defines.push(".define(\"LUMIVERSE_EXPERIMENTAL_HIGH_REFRESH\")");
        }
        // Cargo's DEBUG describes debuginfo (disabled even in our dev profile),
        // so SwiftPM's configuration alone cannot identify a debug app build.
        if std::env::var("PROFILE").as_deref() == Ok("debug") {
            defines.push(".define(\"LUMIVERSE_DEBUG\")");
        }
        manifest = manifest.replace("/* LUMIVERSE_HIGH_REFRESH_SETTINGS */",
            &format!(", swiftSettings: [{}]", defines.join(", ")));
        std::fs::write(package.join("Package.swift"), manifest).unwrap();
        for entry in std::fs::read_dir(source.join("Sources")).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|ext| ext == "swift") {
                std::fs::copy(&path, package.join("Sources").join(path.file_name().unwrap())).unwrap();
            }
        }
        builder = builder.ios_path(package);
    }
    builder.build();
}
