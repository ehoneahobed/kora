pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_kora_sqlite::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
