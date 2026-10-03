// NEW-STORE-11 probe: which journal modes opfs-sahpool accepts, and what each costs per
// small write transaction. Raw @sqlite.org/sqlite-wasm, the same VFS Kora uses.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'

self.onmessage = async (event) => {
	const { id, transactions = 300 } = event.data
	try {
		const sqlite3 = await sqlite3InitModule({
			locateFile: () => '/sqlite3.wasm',
			print: () => {},
			printErr: () => {},
		})
		const pool = await sqlite3.installOpfsSAHPoolVfs({ name: `journal-probe-${id}` })
		await pool.reserveMinimumCapacity(16)
		const results = []
		for (const requested of ['wal', 'delete', 'truncate', 'persist']) {
			const file = `/probe-${requested}.db`
			const db = new pool.OpfsSAHPoolDb(file)
			const rows = db.exec({
				sql: `PRAGMA journal_mode = ${requested}`,
				returnValue: 'resultRows',
				rowMode: 'array',
			})
			const actual = String(rows[0]?.[0] ?? '')
			db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)')
			const t0 = performance.now()
			for (let i = 0; i < transactions; i++) {
				db.exec('BEGIN')
				db.exec({ sql: 'INSERT INTO t (v) VALUES (?)', bind: [`row-${i}`] })
				db.exec('COMMIT')
			}
			const ms = performance.now() - t0
			results.push({
				requested,
				actual,
				perTransactionMs: ms / transactions,
				filesAtRest: pool.getFileCount(),
			})
			db.close()
		}
		await pool.removeVfs()
		postMessage({ id, ok: true, data: results })
	} catch (error) {
		postMessage({ id, ok: false, error: String(error?.message ?? error) })
	}
}
postMessage({ ready: true })
