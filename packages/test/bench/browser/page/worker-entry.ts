// Kora's shipped dedicated SQLite worker, with the wasm URL pinned like an app's build does.
// The dynamic import runs the assignment first, before the worker core reads the URL.
export {}
;(globalThis as Record<string, unknown>).__KORA_SQLITE_WASM_URL = '/sqlite3.wasm'
await import('@korajs/store/sqlite-wasm/worker')
