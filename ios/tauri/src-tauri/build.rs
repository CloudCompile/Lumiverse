fn main() {
    let manifest = tauri_build::AppManifest::new()
        .commands(&["mobile_connection_info", "mobile_connect"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("Tauri iOS client build failed");
}
