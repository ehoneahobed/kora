// Low-level probe of @sqlite.org/sqlite-wasm's opfs-sahpool (the VFS Kora uses).
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
let sqlite3
let pool
const dbs = new Map()
const ok = (id, data) => postMessage({ id, ok: true, data })
const fail = (id, e) =>
	postMessage({ id, ok: false, error: { name: e?.name, message: String(e?.message ?? e) } })
self.onmessage = async (ev) => {
	const { id, cmd, args = {} } = ev.data
	try {
		if (!sqlite3)
			sqlite3 = await sqlite3InitModule({
				locateFile: () => '/sqlite3.wasm',
				print: () => {},
				printErr: () => {},
			})
		switch (cmd) {
			case 'install': {
				const t0 = performance.now()
				pool = await sqlite3.installOpfsSAHPoolVfs({
					name: args.name ?? 'kora-opfs',
					...(args.opts ?? {}),
				})
				return ok(id, {
					ms: performance.now() - t0,
					capacity: pool.getCapacity(),
					files: pool.getFileNames(),
				})
			}
			case 'state':
				return ok(id, {
					capacity: pool.getCapacity(),
					count: pool.getFileCount(),
					files: pool.getFileNames(),
				})
			case 'open': {
				const db = new pool.OpfsSAHPoolDb(args.file)
				dbs.set(args.file, db)
				const jm = db.exec({
					sql: 'PRAGMA journal_mode = WAL',
					returnValue: 'resultRows',
					rowMode: 'array',
				})
				return ok(id, { journalMode: jm, files: pool.getFileNames() })
			}
			case 'exec': {
				const db = dbs.get(args.file)
				const rows = db.exec({
					sql: args.sql,
					bind: args.bind,
					returnValue: 'resultRows',
					rowMode: 'object',
				})
				return ok(id, { rows, files: pool.getFileNames() })
			}
			case 'close': {
				dbs.get(args.file)?.close()
				dbs.delete(args.file)
				return ok(id, {})
			}
			case 'lmsEvictOpen': {
				// Verbatim logic of the LMS report's proposed fix #6.
				const filename = args.file
				const pathMatchesDb = (name, f) =>
					name === `/${f}` || name === f || name.startsWith(`/${f}-`) || name.startsWith(`${f}-`)
				let db
				const evicted = []
				try {
					db = new pool.OpfsSAHPoolDb(filename)
				} catch (error) {
					if (!args.anyError && !/SAH pool is full/i.test(error?.message)) throw error
					for (const name of pool.getFileNames()) {
						if (pathMatchesDb(name, filename)) continue
						try {
							pool.unlink(name)
							evicted.push(name)
						} catch {}
					}
					db = new pool.OpfsSAHPoolDb(filename)
				}
				dbs.set(filename, db)
				return ok(id, { evicted, files: pool.getFileNames() })
			}
			default:
				throw new Error(`unknown cmd ${cmd}`)
		}
	} catch (e) {
		fail(id, e)
	}
}
postMessage({ ready: true })
