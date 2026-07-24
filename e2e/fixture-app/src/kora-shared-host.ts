// SharedWorker host entry (real usage pattern: static imports).
import sqliteWasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url'
import '@korajs/store/sqlite-wasm/shared-host'
;(globalThis as Record<string, unknown>).__KORA_SQLITE_WASM_URL = sqliteWasmUrl
