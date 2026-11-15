use serde::Serialize;

/// Errors that can occur in the Kora SQLite plugin.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Database not loaded: {0}")]
    DatabaseNotLoaded(String),

    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// The prefix `STORAGE_IN_USE:` lets the JavaScript side raise `StorageInUseError`.
    #[error("STORAGE_IN_USE: database {0} is open; close it before deleting it")]
    InUse(String),

    #[error("Plugin error: {0}")]
    Plugin(String),
}

// Tauri requires errors to implement Serialize to send them across the IPC boundary.
impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
