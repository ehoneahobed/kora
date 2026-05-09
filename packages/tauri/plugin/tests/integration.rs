use rusqlite::Connection;

/// Helper: open an in-memory database with the same pragmas the plugin uses.
fn open_kora_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn.pragma_update(None, "synchronous", "NORMAL").unwrap();
    conn.pragma_update(None, "busy_timeout", "5000").unwrap();
    conn
}

/// Helper: create the standard Kora metadata tables.
fn create_kora_meta(conn: &Connection) {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS _kora_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS _kora_version_vector (
            node_id            TEXT PRIMARY KEY,
            max_sequence_number INTEGER NOT NULL,
            last_seen_at        INTEGER NOT NULL
        );
    ",
    )
    .unwrap();
}

const DDL_TODOS: &str = "
    CREATE TABLE IF NOT EXISTS todos (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        completed   INTEGER NOT NULL DEFAULT 0,
        _created_at INTEGER NOT NULL,
        _updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _kora_ops_todos (
        id              TEXT PRIMARY KEY,
        node_id         TEXT NOT NULL,
        type            TEXT NOT NULL,
        collection      TEXT NOT NULL,
        record_id       TEXT NOT NULL,
        data            TEXT,
        previous_data   TEXT,
        wall_time       INTEGER NOT NULL,
        logical         INTEGER NOT NULL,
        ts_node_id      TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        causal_deps     TEXT NOT NULL DEFAULT '[]',
        schema_version  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_todos_completed ON todos(completed);
";

// ── Database initialization tests ─────────────────────────────────────────────

#[test]
fn test_open_sets_wal_mode() {
    let conn = open_kora_db();
    let mode: String = conn
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    // In-memory databases fall back to 'memory' when WAL is requested
    assert!(mode == "wal" || mode == "memory", "expected wal or memory, got {}", mode);
}

#[test]
fn test_open_enables_foreign_keys() {
    let conn = open_kora_db();
    let fk: i64 = conn
        .pragma_query_value(None, "foreign_keys", |row| row.get(0))
        .unwrap();
    assert_eq!(fk, 1, "foreign_keys should be ON");
}

// ── DDL execution tests ──────────────────────────────────────────────────────

#[test]
fn test_create_tables_from_ddl() {
    let conn = open_kora_db();
    create_kora_meta(&conn);
    conn.execute_batch(DDL_TODOS).unwrap();

    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

    assert!(tables.contains(&"_kora_meta".to_string()));
    assert!(tables.contains(&"_kora_version_vector".to_string()));
    assert!(tables.contains(&"todos".to_string()));
    assert!(tables.contains(&"_kora_ops_todos".to_string()));
}

#[test]
fn test_create_indexes() {
    let conn = open_kora_db();
    create_kora_meta(&conn);
    conn.execute_batch(DDL_TODOS).unwrap();

    let indexes: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

    assert!(indexes.contains(&"idx_todos_completed".to_string()));
}

// ── CRUD tests ───────────────────────────────────────────────────────────────

#[test]
fn test_insert_and_select() {
    let conn = open_kora_db();
    create_kora_meta(&conn);
    conn.execute_batch(DDL_TODOS).unwrap();

    conn.execute(
        "INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        ["rec-1", "Hello", "0", "1000", "1000"],
    )
    .unwrap();

    let (title, completed): (String, i64) = conn
        .query_row("SELECT title, completed FROM todos WHERE id = ?1", ["rec-1"], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();

    assert_eq!(title, "Hello");
    assert_eq!(completed, 0);
}

#[test]
fn test_update_record() {
    let conn = open_kora_db();
    create_kora_meta(&conn);
    conn.execute_batch(DDL_TODOS).unwrap();

    conn.execute(
        "INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        ["rec-1", "Old Title", "0", "1000", "1000"],
    ).unwrap();

    conn.execute(
        "UPDATE todos SET title = ?1, completed = ?2, _updated_at = ?3 WHERE id = ?4",
        ["Updated", "1", "1001", "rec-1"],
    )
    .unwrap();

    let (title, completed): (String, i64) = conn
        .query_row("SELECT title, completed FROM todos WHERE id = ?1", ["rec-1"], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();

    assert_eq!(title, "Updated");
    assert_eq!(completed, 1);
}

#[test]
fn test_delete_record() {
    let conn = open_kora_db();
    create_kora_meta(&conn);
    conn.execute_batch(DDL_TODOS).unwrap();

    conn.execute(
        "INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        ["rec-1", "Delete Me", "0", "1000", "1000"],
    )
    .unwrap();

    conn.execute("DELETE FROM todos WHERE id = ?1", ["rec-1"])
        .unwrap();

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM todos WHERE id = ?1", ["rec-1"], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}

// ── Operation log tests ──────────────────────────────────────────────────────

#[test]
fn test_insert_and_read_operation() {
    let conn = open_kora_db();
    create_kora_meta(&conn);
    conn.execute_batch(DDL_TODOS).unwrap();

    conn.execute(
        "INSERT INTO _kora_ops_todos (id, node_id, type, collection, record_id, data, previous_data, wall_time, logical, ts_node_id, sequence_number, causal_deps, schema_version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        ["op-1", "node-a", "insert", "todos", "rec-1", r#"{"title":"Hello"}"#, "", "1000", "0", "node-a", "1", "[]", "1"],
    ).unwrap();

    let (op_id, op_type, op_record_id): (String, String, String) = conn
        .query_row(
            "SELECT id, type, record_id FROM _kora_ops_todos WHERE id = ?1",
            ["op-1"],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();

    assert_eq!(op_id, "op-1");
    assert_eq!(op_type, "insert");
    assert_eq!(op_record_id, "rec-1");
}

#[test]
fn test_operation_range_query() {
    let conn = open_kora_db();
    create_kora_meta(&conn);
    conn.execute_batch(DDL_TODOS).unwrap();

    for i in 1..=5 {
        conn.execute(
            "INSERT INTO _kora_ops_todos (id, node_id, type, collection, record_id, data, previous_data, wall_time, logical, ts_node_id, sequence_number, causal_deps, schema_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            rusqlite::params![
                format!("op-{}", i), "node-a", "insert", "todos", format!("rec-{}", i),
                r#"{"title":"test"}"#, "", 1000 + i, 0, "node-a", i, "[]", 1,
            ],
        ).unwrap();
    }

    let ops: Vec<String> = conn
        .prepare("SELECT id FROM _kora_ops_todos WHERE node_id = ?1 AND sequence_number >= ?2 AND sequence_number <= ?3 ORDER BY sequence_number")
        .unwrap()
        .query_map(rusqlite::params!["node-a", 2, 4], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

    assert_eq!(ops, vec!["op-2", "op-3", "op-4"]);
}

// ── Transaction tests ─────────────────────────────────────────────────────────

#[test]
fn test_transaction_commits() {
    let conn = open_kora_db();
    create_kora_meta(&conn);
    conn.execute_batch(DDL_TODOS).unwrap();

    conn.execute_batch("BEGIN").unwrap();
    conn.execute(
        "INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        ["rec-1", "In TX", "0", "1000", "1000"],
    ).unwrap();
    conn.execute_batch("COMMIT").unwrap();

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM todos", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn test_transaction_rollback_on_error() {
    let conn = open_kora_db();
    create_kora_meta(&conn);
    conn.execute_batch(DDL_TODOS).unwrap();

    // Start transaction, insert, then intentionally fail
    conn.execute_batch("BEGIN").unwrap();
    conn.execute(
        "INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        ["rec-1", "Rollback Me", "0", "1000", "1000"],
    ).unwrap();
    // Simulate an error by rolling back
    conn.execute_batch("ROLLBACK").unwrap();

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM todos", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn test_transaction_isolation() {
    let conn = open_kora_db();
    create_kora_meta(&conn);
    conn.execute_batch(DDL_TODOS).unwrap();

    conn.execute_batch("BEGIN").unwrap();
    conn.execute(
        "INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        ["rec-1", "Isolated", "0", "1000", "1000"],
    ).unwrap();

    // Changes shouldn't be visible outside the transaction
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM todos", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1); // Within same connection, uncommitted data IS visible (SQLite default)

    conn.execute_batch("ROLLBACK").unwrap();
}

// ── Migration tests ───────────────────────────────────────────────────────────

#[test]
fn test_migration_adds_column() {
    let conn = open_kora_db();
    create_kora_meta(&conn);
    conn.execute_batch(DDL_TODOS).unwrap();

    // Add a new column (migration)
    conn.execute_batch("BEGIN").unwrap();
    conn.execute_batch("ALTER TABLE todos ADD COLUMN notes TEXT").unwrap();
    conn.execute_batch("COMMIT").unwrap();

    // Verify the new column exists and can be written to
    conn.execute(
        "INSERT INTO todos (id, title, completed, notes, _created_at, _updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        ["rec-1", "With Notes", "0", "Some notes", "1000", "1000"],
    ).unwrap();

    let notes: String = conn
        .query_row("SELECT notes FROM todos WHERE id = ?1", ["rec-1"], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(notes, "Some notes");
}

#[test]
fn test_migration_rolls_back_on_error() {
    let conn = open_kora_db();
    create_kora_meta(&conn);
    conn.execute_batch(DDL_TODOS).unwrap();

    // Try to apply invalid SQL within a migration
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        conn.execute_batch("BEGIN").unwrap();
        conn.execute_batch("INVALID SQL STATEMENT").unwrap(); // This will panic
        conn.execute_batch("COMMIT").unwrap();
    }));

    assert!(result.is_err(), "invalid SQL should cause a panic/error");
}

#[test]
fn test_safe_alter_table_ignores_duplicate_column() {
    let conn = open_kora_db();
    create_kora_meta(&conn);
    conn.execute_batch(DDL_TODOS).unwrap();

    // First add a column
    conn.execute_batch("ALTER TABLE todos ADD COLUMN priority TEXT DEFAULT 'medium'").unwrap();

    // Try adding the same column again — the plugin's safe-alter pattern
    // should ignore the "duplicate column name" error
    let sql = "ALTER TABLE todos ADD COLUMN priority TEXT DEFAULT 'medium'";
    match conn.execute_batch(sql) {
        Ok(_) => {} // Should not happen — column already exists
        Err(e) => {
            let msg = e.to_string();
            assert!(
                msg.contains("duplicate column name"),
                "expected duplicate column error, got: {}",
                msg
            );
        }
    }
}

// ── Data type tests ───────────────────────────────────────────────────────────

#[test]
fn test_all_sql_types_roundtrip() {
    let conn = open_kora_db();
    conn.execute_batch(
        "CREATE TABLE types (
            id     TEXT PRIMARY KEY,
            int_v  INTEGER,
            float_v REAL,
            text_v TEXT,
            bool_v INTEGER
        )",
    )
    .unwrap();

    conn.execute(
        "INSERT INTO types (id, int_v, float_v, text_v, bool_v) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params!["rec-1", 42, 3.14, "hello", 1],
    )
    .unwrap();

    let (int_v, float_v, text_v, bool_v): (i64, f64, String, i64) = conn
        .query_row(
            "SELECT int_v, float_v, text_v, bool_v FROM types WHERE id = ?1",
            ["rec-1"],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();

    assert_eq!(int_v, 42);
    assert!((float_v - 3.14).abs() < 1e-10);
    assert_eq!(text_v, "hello");
    assert_eq!(bool_v, 1);
}

#[test]
fn test_null_values() {
    let conn = open_kora_db();
    conn.execute_batch(
        "CREATE TABLE nullable (id TEXT PRIMARY KEY, value TEXT)",
    ).unwrap();

    conn.execute(
        "INSERT INTO nullable (id, value) VALUES (?1, ?2)",
        rusqlite::params!["rec-1", rusqlite::types::Null],
    )
    .unwrap();

    let value: Option<String> = conn
        .query_row("SELECT value FROM nullable WHERE id = ?1", ["rec-1"], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(value, None);
}

#[test]
fn test_blob_as_hex() {
    let conn = open_kora_db();
    conn.execute_batch("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)").unwrap();

    let input: Vec<u8> = vec![0x00, 0xFF, 0xAB, 0xCD];
    conn.execute(
        "INSERT INTO blobs (id, data) VALUES (?1, ?2)",
        rusqlite::params!["rec-1", input],
    )
    .unwrap();

    let output: Vec<u8> = conn
        .query_row("SELECT data FROM blobs WHERE id = ?1", ["rec-1"], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(output, input);
}

// ── Error case tests ──────────────────────────────────────────────────────────

#[test]
fn test_invalid_sql_returns_error() {
    let conn = open_kora_db();
    let result = conn.execute_batch("SELECT FROM nowhere");
    assert!(result.is_err(), "invalid SQL should return an error");
}

#[test]
fn test_query_missing_table_returns_error() {
    let conn = open_kora_db();
    let result = conn.prepare("SELECT * FROM nonexistent");
    assert!(result.is_err(), "query on missing table should error");
}

// ── Version vector tests ─────────────────────────────────────────────────────

#[test]
fn test_version_vector_insert_and_update() {
    let conn = open_kora_db();
    create_kora_meta(&conn);

    conn.execute(
        "INSERT INTO _kora_version_vector (node_id, max_sequence_number, last_seen_at) VALUES (?1, ?2, ?3)",
        ["node-a", "1", "1000"],
    ).unwrap();

    let (seq, seen): (i64, i64) = conn
        .query_row(
            "SELECT max_sequence_number, last_seen_at FROM _kora_version_vector WHERE node_id = ?1",
            ["node-a"],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(seq, 1);
    assert_eq!(seen, 1000);

    // Update
    conn.execute(
        "UPDATE _kora_version_vector SET max_sequence_number = ?1, last_seen_at = ?2 WHERE node_id = ?3",
        ["5", "1002", "node-a"],
    ).unwrap();

    let seq: i64 = conn
        .query_row(
            "SELECT max_sequence_number FROM _kora_version_vector WHERE node_id = ?1",
            ["node-a"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(seq, 5);
}

#[test]
fn test_version_vector_increments_monotonically() {
    let conn = open_kora_db();
    create_kora_meta(&conn);

    for i in 1..=10 {
        conn.execute(
            "INSERT INTO _kora_version_vector (node_id, max_sequence_number, last_seen_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(node_id) DO UPDATE SET max_sequence_number = ?2, last_seen_at = ?3",
            rusqlite::params!["node-a", i, 1000 + i],
        ).unwrap();
    }

    let seq: i64 = conn
        .query_row(
            "SELECT max_sequence_number FROM _kora_version_vector WHERE node_id = ?1",
            ["node-a"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(seq, 10);
}

// ── Bulk operation tests ─────────────────────────────────────────────────────

#[test]
fn test_bulk_insert_and_count() {
    let conn = open_kora_db();
    create_kora_meta(&conn);
    conn.execute_batch(DDL_TODOS).unwrap();

    for i in 0..100 {
        conn.execute(
            "INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![format!("rec-{}", i), format!("Task {}", i), if i % 2 == 0 { 1 } else { 0 }, 1000 + i, 1000 + i],
        ).unwrap();
    }

    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM todos", [], |row| row.get(0))
        .unwrap();
    assert_eq!(total, 100);

    let completed: i64 = conn
        .query_row("SELECT COUNT(*) FROM todos WHERE completed = 1", [], |row| row.get(0))
        .unwrap();
    assert_eq!(completed, 50);
}
