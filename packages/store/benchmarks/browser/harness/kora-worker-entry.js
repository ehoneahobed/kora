// Kora's shipped dedicated SQLite worker (dist), with the wasm URL pinned like an app's build does.
globalThis.__KORA_SQLITE_WASM_URL = '/sqlite3.wasm'
await import('../../../dist/adapters/sqlite-wasm-worker.js')
