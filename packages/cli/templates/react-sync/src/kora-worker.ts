// Web Worker entry point for SQLite WASM.
// Loaded automatically by the Kora store to run SQLite in a background thread.

// Import the WASM binary URL so Vite resolves it with the correct content hash.
// Without this, production builds fail because sqlite3 looks for the unhashed filename.
import sqliteWasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url'

;(globalThis as Record<string, unknown>).__KORA_SQLITE_WASM_URL = sqliteWasmUrl

import '@korajs/store/sqlite-wasm/worker'
