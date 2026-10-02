// The 1.0.0-beta.12 dedicated worker (frozen fixture), used to create databases the way
// beta.12 stored them: every database in the one origin-wide 'kora-opfs' SAH pool.
import { createSqliteWasmCore } from './beta12-worker-core.ts'

globalThis.__KORA_SQLITE_WASM_URL = '/sqlite3.wasm'
const core = createSqliteWasmCore()
self.onmessage = (event) => {
	void core.handle(event.data).then((response) => self.postMessage(response))
}
