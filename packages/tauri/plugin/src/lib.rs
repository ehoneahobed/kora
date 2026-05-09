//! # tauri-plugin-kora
//!
//! Tauri plugin providing native SQLite storage for Kora.js applications.
//!
//! This plugin exposes SQLite operations via Tauri IPC commands, configured with
//! WAL mode, foreign keys, and proper pragmas for optimal offline-first performance.
//!
//! ## Setup
//!
//! Add the plugin to your Tauri app:
//!
//! ```rust,ignore
//! fn main() {
//!     tauri::Builder::default()
//!         .plugin(tauri_plugin_kora_sqlite::init())
//!         .run(tauri::generate_context!())
//!         .expect("error while running tauri application");
//! }
//! ```
//!
//! Then add the permissions to your `capabilities/default.json`:
//!
//! ```json
//! {
//!   "permissions": ["kora-sqlite:default"]
//! }
//! ```

mod commands;
mod error;

use commands::DbState;
use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    Manager, Runtime,
};

/// Initialize the Kora SQLite plugin.
///
/// Registers IPC command handlers for database operations and manages
/// the lifecycle of SQLite connections.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("kora-sqlite")
        .setup(|app, _api| {
            app.manage(DbState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open,
            commands::close,
            commands::execute,
            commands::query,
            commands::migrate,
        ])
        .build()
}
