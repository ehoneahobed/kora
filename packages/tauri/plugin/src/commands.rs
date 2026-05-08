use std::collections::HashMap;
use std::sync::Mutex;

use rusqlite::{params_from_iter, Connection};
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
        data_dir
            .join(&path)
            .to_string_lossy()
            .into_owned()
    };

    let conn = Connection::open(&db_path)?;

    // Configure SQLite for optimal performance and correctness
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
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
    let column_names: Vec<String> = stmt
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect();

    let rows = stmt.query_map(param_slice.as_slice(), |row| {
        let mut map = HashMap::new();
        for (i, name) in column_names.iter().enumerate() {
            let value: JsonValue = match row.get_ref(i) {
                Ok(rusqlite::types::ValueRef::Null) => JsonValue::Null,
                Ok(rusqlite::types::ValueRef::Integer(n)) => JsonValue::Number(n.into()),
                Ok(rusqlite::types::ValueRef::Real(f)) => {
                    match serde_json::Number::from_f64(f) {
                        Some(n) => JsonValue::Number(n),
                        None => JsonValue::Null,
                    }
                }
                Ok(rusqlite::types::ValueRef::Text(s)) => {
                    JsonValue::String(String::from_utf8_lossy(s).into_owned())
                }
                Ok(rusqlite::types::ValueRef::Blob(b)) => {
                    // Encode blobs as hex strings for transport
                    let hex: String = b.iter().map(|byte| format!("{:02x}", byte)).collect();
                    JsonValue::String(hex)
                }
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
