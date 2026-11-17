use std::collections::HashMap;
use std::sync::Mutex;

use rusqlite::Connection;
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::error::Error;

/// Managed state holding open database connections.
/// Each database is identified by its file path.
pub struct DbState {
    pub connections: Mutex<HashMap<String, Connection>>,
}

impl Default for DbState {
    fn default() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
        }
    }
}

/// Convert a JSON value to a rusqlite parameter.
fn json_to_param(value: &JsonValue) -> Box<dyn rusqlite::types::ToSql> {
    match value {
        JsonValue::Null => Box::new(rusqlite::types::Null),
        JsonValue::Bool(b) => Box::new(if *b { 1i64 } else { 0i64 }),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                Box::new(i)
            } else if let Some(f) = n.as_f64() {
                Box::new(f)
            } else {
                Box::new(rusqlite::types::Null)
            }
        }
        JsonValue::String(s) => Box::new(s.clone()),
        // Arrays and objects are stored as JSON text
        _ => Box::new(value.to_string()),
    }
}

/// Convert a column value to its JSON transport form.
fn value_ref_to_json(value: rusqlite::types::ValueRef<'_>) -> JsonValue {
    match value {
        rusqlite::types::ValueRef::Null => JsonValue::Null,
        rusqlite::types::ValueRef::Integer(n) => JsonValue::Number(n.into()),
        rusqlite::types::ValueRef::Real(f) => match serde_json::Number::from_f64(f) {
            Some(n) => JsonValue::Number(n),
            None => JsonValue::Null,
        },
        rusqlite::types::ValueRef::Text(s) => {
            JsonValue::String(String::from_utf8_lossy(s).into_owned())
        }
        rusqlite::types::ValueRef::Blob(b) => {
            // Encode blobs as hex strings for transport
            let hex: String = b.iter().map(|byte| format!("{:02x}", byte)).collect();
            JsonValue::String(hex)
        }
    }
}

/// Open a database and execute DDL statements.
/// Configures WAL mode, foreign keys, and other pragmas.
#[tauri::command]
pub fn open<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DbState>,
    path: String,
    statements: Vec<String>,
) -> Result<(), Error> {
    let mut connections = state
        .connections
        .lock()
        .map_err(|e| Error::Plugin(format!("Failed to acquire lock: {}", e)))?;

    // Resolve the database path relative to the app's data directory
    let db_path = if path == ":memory:" {
        path.clone()
    } else {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| Error::Plugin(format!("Failed to get app data dir: {}", e)))?;
        std::fs::create_dir_all(&data_dir)?;
        data_dir.join(&path).to_string_lossy().into_owned()
    };

    let conn = Connection::open(&db_path)?;

    // Configure SQLite for optimal performance and correctness
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // A resolved write is a durability promise, including across power loss.
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "busy_timeout", "5000")?;

    // Execute DDL statements from the schema
    for sql in &statements {
        if sql.starts_with("--kora:safe-alter") {
            // Safe ALTER TABLE — ignore "duplicate column name" errors
            let clean_sql = sql.replace("--kora:safe-alter\n", "");
            match conn.execute_batch(&clean_sql) {
                Ok(_) => {}
                Err(e) => {
                    let msg = e.to_string();
                    if !msg.contains("duplicate column name") {
                        return Err(Error::Sqlite(e));
                    }
                }
            }
        } else {
            conn.execute_batch(sql)?;
        }
    }

    log::info!("Opened Kora database: {}", db_path);
    connections.insert(path, conn);
    Ok(())
}

/// What `inspect` reports about a database file.
#[derive(serde::Serialize)]
pub struct DatabaseFileState {
    /// This app has the database open (`open` was called and not closed).
    pub open: bool,
    /// The database file exists in the app's data directory.
    pub exists: bool,
}

/// A database name a caller may delete: relative to the app's data directory, never a parent
/// or absolute path (which `PathBuf::join` would follow out of it), never `:memory:`.
pub fn validate_database_path(path: &str) -> Result<(), Error> {
    use std::path::Component;
    let candidate = std::path::Path::new(path);
    let inside = !path.is_empty()
        && path != ":memory:"
        && candidate
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
    if inside {
        Ok(())
    } else {
        Err(Error::Plugin(format!(
            "\"{}\" is not a database file in the app's data directory",
            path
        )))
    }
}

/// Delete a database file and SQLite's companion files (`-wal`, `-shm`, `-journal`).
/// Returns whether the database file existed.
pub fn delete_database_files(db_path: &std::path::Path) -> Result<bool, Error> {
    let existed = db_path.exists();
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut companion = db_path.as_os_str().to_owned();
        companion.push(suffix);
        match std::fs::remove_file(std::path::PathBuf::from(companion)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(Error::Io(error)),
        }
    }
    // The main file last: until it is gone, the database is still whole.
    match std::fs::remove_file(db_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(Error::Io(error)),
    }
    Ok(existed)
}

fn data_dir_path<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<std::path::PathBuf, Error> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| Error::Plugin(format!("Failed to get app data dir: {}", e)))?;
    Ok(data_dir.join(path))
}

/// Whether a database is open in this app, and whether its file exists.
#[tauri::command]
pub fn inspect<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DbState>,
    path: String,
) -> Result<DatabaseFileState, Error> {
    validate_database_path(&path)?;
    let connections = state
        .connections
        .lock()
        .map_err(|e| Error::Plugin(format!("Failed to acquire lock: {}", e)))?;
    Ok(DatabaseFileState {
        open: connections.contains_key(&path),
        exists: data_dir_path(&app, &path)?.exists(),
    })
}

/// Permanently delete a closed database (`app.storage.deleteDatabase`). Refuses while the
/// database is open: close the app first. Returns whether a database file existed.
#[tauri::command]
pub fn delete<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DbState>,
    path: String,
) -> Result<bool, Error> {
    validate_database_path(&path)?;
    // Held for the whole delete, so no `open` of this database can start halfway.
    let connections = state
        .connections
        .lock()
        .map_err(|e| Error::Plugin(format!("Failed to acquire lock: {}", e)))?;
    if connections.contains_key(&path) {
        return Err(Error::InUse(path));
    }
    let existed = delete_database_files(&data_dir_path(&app, &path)?)?;
    if existed {
        log::info!("Deleted Kora database: {}", path);
    }
    Ok(existed)
}

/// Close a database connection.
#[tauri::command]
pub fn close(state: State<'_, DbState>, path: String) -> Result<(), Error> {
    let mut connections = state
        .connections
        .lock()
        .map_err(|e| Error::Plugin(format!("Failed to acquire lock: {}", e)))?;

    if connections.remove(&path).is_some() {
        log::info!("Closed Kora database: {}", path);
    }
    Ok(())
}

/// Execute a write query (INSERT, UPDATE, DELETE, or DDL like BEGIN/COMMIT/ROLLBACK).
#[tauri::command]
pub fn execute(
    state: State<'_, DbState>,
    path: String,
    sql: String,
    params: Vec<JsonValue>,
) -> Result<(), Error> {
    let connections = state
        .connections
        .lock()
        .map_err(|e| Error::Plugin(format!("Failed to acquire lock: {}", e)))?;

    let conn = connections
        .get(&path)
        .ok_or_else(|| Error::DatabaseNotLoaded(path.clone()))?;

    if params.is_empty() {
        // For statements without parameters (BEGIN, COMMIT, ROLLBACK, DDL)
        conn.execute_batch(&sql)?;
    } else {
        let param_refs: Vec<Box<dyn rusqlite::types::ToSql>> =
            params.iter().map(json_to_param).collect();
        let param_slice: Vec<&dyn rusqlite::types::ToSql> =
            param_refs.iter().map(|p| p.as_ref()).collect();
        conn.execute(&sql, param_slice.as_slice())?;
    }
    Ok(())
}

/// Execute a read query (SELECT) and return results as JSON.
#[tauri::command]
pub fn query(
    state: State<'_, DbState>,
    path: String,
    sql: String,
    params: Vec<JsonValue>,
) -> Result<Vec<HashMap<String, JsonValue>>, Error> {
    let connections = state
        .connections
        .lock()
        .map_err(|e| Error::Plugin(format!("Failed to acquire lock: {}", e)))?;

    let conn = connections
        .get(&path)
        .ok_or_else(|| Error::DatabaseNotLoaded(path.clone()))?;

    let param_refs: Vec<Box<dyn rusqlite::types::ToSql>> =
        params.iter().map(json_to_param).collect();
    let param_slice: Vec<&dyn rusqlite::types::ToSql> =
        param_refs.iter().map(|p| p.as_ref()).collect();

    let mut stmt = conn.prepare(&sql)?;
    let column_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();

    let rows = stmt.query_map(param_slice.as_slice(), |row| {
        let mut map = HashMap::new();
        for (i, name) in column_names.iter().enumerate() {
            let value = match row.get_ref(i) {
                Ok(value) => value_ref_to_json(value),
                Err(_) => JsonValue::Null,
            };
            map.insert(name.clone(), value);
        }
        Ok(map)
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Apply a migration within a transaction.
#[tauri::command]
pub fn migrate(
    state: State<'_, DbState>,
    path: String,
    statements: Vec<String>,
) -> Result<(), Error> {
    let connections = state
        .connections
        .lock()
        .map_err(|e| Error::Plugin(format!("Failed to acquire lock: {}", e)))?;

    let conn = connections
        .get(&path)
        .ok_or_else(|| Error::DatabaseNotLoaded(path.clone()))?;

    conn.execute_batch("BEGIN")?;
    match (|| -> Result<(), Error> {
        for sql in &statements {
            conn.execute_batch(sql)?;
        }
        Ok(())
    })() {
        Ok(_) => {
            conn.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

#[cfg(test)]
mod delete_tests {
    use super::{delete_database_files, validate_database_path};

    fn scratch_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kora-sqlite-delete-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_names_inside_the_data_directory_can_be_deleted() {
        assert!(validate_database_path("kora-db.db").is_ok());
        assert!(validate_database_path("tenants/a.db").is_ok());
        for refused in [
            "",
            ":memory:",
            "../other.db",
            "/etc/passwd",
            "a/../../b.db",
            "./a.db",
        ] {
            assert!(
                validate_database_path(refused).is_err(),
                "{refused} must be refused"
            );
        }
    }

    #[test]
    fn deleting_removes_the_database_and_its_companion_files() {
        let dir = scratch_dir("files");
        let db = dir.join("kora-db.db");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.pragma_update(None, "journal_mode", "WAL").unwrap();
            conn.execute_batch("CREATE TABLE t (x); INSERT INTO t VALUES (1);")
                .unwrap();
        }
        std::fs::write(dir.join("kora-db.db-journal"), b"").unwrap();
        std::fs::write(dir.join("other.db"), b"keep").unwrap();

        assert!(delete_database_files(&db).unwrap());
        for name in [
            "kora-db.db",
            "kora-db.db-wal",
            "kora-db.db-shm",
            "kora-db.db-journal",
        ] {
            assert!(!dir.join(name).exists(), "{name} should be gone");
        }
        assert!(
            dir.join("other.db").exists(),
            "other databases are untouched"
        );
        // Nothing left: reports that no database existed.
        assert!(!delete_database_files(&db).unwrap());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[cfg(test)]
mod binary_value_tests {
    use super::{json_to_param, value_ref_to_json};
    use serde_json::json;

    /// Bind `param` into a fresh table and read the column back as SQLite stored it.
    fn store(param: serde_json::Value) -> (String, serde_json::Value) {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (v)").unwrap();
        let bound = json_to_param(&param);
        conn.execute("INSERT INTO t (v) VALUES (?1)", [bound.as_ref()])
            .unwrap();
        conn.query_row("SELECT typeof(v), v FROM t", [], |row| {
            Ok((row.get::<_, String>(0)?, value_ref_to_json(row.get_ref(1)?)))
        })
        .unwrap()
    }

    #[test]
    fn a_tagged_bytes_value_is_stored_as_a_blob_and_read_back_tagged() {
        // [0, 1, 255] in base64.
        let (kind, back) = store(json!({ "$koraBytes": "AAH/" }));
        assert_eq!(kind, "blob");
        assert_eq!(back, json!({ "$koraBytes": "AAH/" }));
    }

    #[test]
    fn every_length_and_byte_value_round_trips() {
        for len in 0..70usize {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 37 % 256) as u8).collect();
            let conn = rusqlite::Connection::open_in_memory().unwrap();
            conn.execute_batch("CREATE TABLE t (v)").unwrap();
            conn.execute("INSERT INTO t (v) VALUES (?1)", [&bytes])
                .unwrap();
            let back = conn
                .query_row("SELECT v FROM t", [], |row| {
                    Ok(value_ref_to_json(row.get_ref(0)?))
                })
                .unwrap();
            let (kind, again) = store(back.clone());
            assert_eq!(kind, "blob", "length {len}");
            assert_eq!(again, back, "length {len}");
        }
    }

    #[test]
    fn other_objects_are_still_stored_as_json_text() {
        let (kind, back) = store(json!({ "a": 1 }));
        assert_eq!(kind, "text");
        assert_eq!(back, json!("{\"a\":1}"));
    }
}
