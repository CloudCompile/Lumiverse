use tauri::plugin::{Builder, TauriPlugin};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_lumiverse_ios);

pub fn init<R: tauri::Runtime>() -> TauriPlugin<R> {
    Builder::new("lumiverse-ios")
        .js_init_script(include_str!("mobile-init.js"))
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_lumiverse_ios)?;
            Ok(())
        })
        .build()
}
