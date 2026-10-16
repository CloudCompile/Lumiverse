use tauri::plugin::{Builder, TauriPlugin};

#[tauri::command]
fn mobile_host_info() -> serde_json::Value {
    serde_json::json!({ "host": "tauri", "version": tauri::VERSION, "platform": "android" })
}

fn runtime_plugin() -> TauriPlugin<tauri::Wry> {
    Builder::new("lumiverse-runtime")
        .js_init_script("document.documentElement?.setAttribute('data-tauri-mobile', 'android'); document.documentElement?.setAttribute('data-platform', 'android'); Object.defineProperty(window, '__LUMIVERSE_MOBILE__', {value: true}); document.addEventListener('DOMContentLoaded', () => { document.documentElement.setAttribute('data-tauri-mobile', 'android'); document.documentElement.setAttribute('data-platform', 'android'); });")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            api.register_android_plugin("chat.lumiverse.prototype", "RuntimePlugin")?;
            Ok(())
        })
        .on_navigation(|_webview, url| {
            matches!(url.scheme(), "tauri" | "asset") ||
                (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")) ||
                (url.scheme() == "http" && url.host_str() == Some("127.0.0.1"))
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(runtime_plugin())
        .invoke_handler(tauri::generate_handler![mobile_host_info])
        .run(tauri::generate_context!())
        .expect("Failed to run Lumiverse Android");
}
