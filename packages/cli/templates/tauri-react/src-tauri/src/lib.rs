// The same app runs on desktop and, through Tauri's mobile targets, on iOS and Android.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_kora_sqlite::init());
    // In-app updates are a desktop feature; phones update through their app stores.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
