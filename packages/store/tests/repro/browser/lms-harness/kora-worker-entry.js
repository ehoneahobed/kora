// Kora's shipped dedicated worker (dist), with the wasm URL pinned like the fixture app does.
globalThis.__KORA_SQLITE_WASM_URL = '/sqlite3.wasm'
await import('../../../../dist/adapters/sqlite-wasm-worker.js')
