import { defineSchema, generateFullDDL, t } from '../../../../../core/dist/index.js'
import { IndexedDbAdapter } from '../../../../dist/adapters/indexeddb.js'
import * as sqliteWasm from '../../../../dist/adapters/sqlite-wasm.js'

const { SqliteWasmAdapter } = sqliteWasm

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string() } } },
})
// A collection whose table name SQLite reserves: DDL fails after the file is created.
const badSchema = defineSchema({
	version: 1,
	collections: { sqlite_bad: { fields: { title: t.string() } } },
})
const events = []
const emitter = { emit: (e) => events.push(e), on: () => () => {} }
const adapters = new Map()

function rawWorker() {
	const w = new Worker('/raw-worker.js', { type: 'module' })
	let n = 0
	const pending = new Map()
	const ready = new Promise((r) => {
		w.addEventListener('message', function f(e) {
			if (e.data?.ready) {
				w.removeEventListener('message', f)
				r()
			}
		})
	})
	w.addEventListener('message', (e) => {
		const p = pending.get(e.data?.id)
		if (p) {
			pending.delete(e.data.id)
			p(e.data)
		}
	})
	return {
		ready,
		terminate: () => w.terminate(),
		call: async (cmd, args) => {
			await ready
			const id = ++n
			return new Promise((r) => {
				pending.set(id, r)
				w.postMessage({ id, cmd, args })
			})
		},
	}
}

window.H = {
	events,
	raw: {},
	newRaw(key) {
		this.raw[key] = rawWorker()
		return this.raw[key].ready.then(() => true)
	},
	rawCall(key, cmd, args) {
		return this.raw[key].call(cmd, args)
	},
	killRaw(key) {
		this.raw[key].terminate()
		delete this.raw[key]
		return true
	},
	async open(key, dbName, opts = {}) {
		const t0 = performance.now()
		const A = opts.indexeddb ? IndexedDbAdapter : SqliteWasmAdapter
		const a = new A({
			dbName,
			workerUrl: '/kora-worker.js',
			emitter,
			workerResponseTimeoutMs: opts.timeoutMs ?? 30000,
			...(opts.debounceMs !== undefined ? { persistenceDebounceMs: opts.debounceMs } : {}),
		})
		adapters.set(key, a)
		try {
			await a.open(opts.badSchema ? badSchema : schema)
			return {
				ok: true,
				ms: performance.now() - t0,
				state: a.getStorageOpenState?.() ?? null,
				role: a.inner ? a.inner.tabSession?.role : a.tabSession?.role,
			}
		} catch (e) {
			return { ok: false, error: String(e?.message ?? e), code: e?.context?.code }
		}
	},
	role(key) {
		const a = adapters.get(key)
		return (a.inner ?? a).tabSession?.role
	},
	async insert(key, title) {
		const a = adapters.get(key)
		const t0 = performance.now()
		try {
			await a.execute(
				'INSERT INTO notes (id, title, _created_at, _updated_at) VALUES (?, ?, ?, ?)',
				[crypto.randomUUID(), title, Date.now(), Date.now()],
			)
			return { ok: true, ms: performance.now() - t0 }
		} catch (e) {
			return {
				ok: false,
				ms: performance.now() - t0,
				error: String(e?.message ?? e),
				name: e?.name,
			}
		}
	},
	async titles(key) {
		const a = adapters.get(key)
		const t0 = performance.now()
		try {
			const rows = await a.query('SELECT title FROM notes ORDER BY title')
			return { ok: true, titles: rows.map((r) => r.title), ms: performance.now() - t0 }
		} catch (e) {
			return {
				ok: false,
				ms: performance.now() - t0,
				error: String(e?.message ?? e),
				name: e?.name,
			}
		}
	},
	async slow(key, n) {
		const a = adapters.get(key)
		const t0 = performance.now()
		try {
			const rows = await a.query(
				'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c',
				[n],
			)
			return { ok: true, rows, ms: performance.now() - t0 }
		} catch (e) {
			return {
				ok: false,
				ms: performance.now() - t0,
				error: String(e?.message ?? e),
				name: e?.name,
			}
		}
	},
	startSlow(key, n) {
		window.__slow = this.slow(key, n)
		return true
	},
	awaitSlow() {
		return window.__slow
	},
	async dbList(key) {
		const a = adapters.get(key)
		try {
			return await a.query('PRAGMA database_list')
		} catch (e) {
			return String(e)
		}
	},
	async close(key) {
		const a = adapters.get(key)
		try {
			await a.close()
			return true
		} catch (e) {
			return String(e)
		} finally {
			adapters.delete(key)
		}
	},
	async flush(key) {
		const a = adapters.get(key)
		await a.flushPersistence?.()
		return true
	},
	/** Start an open without awaiting it (to observe a blocked open). */
	startOpen(key, dbName, opts = {}) {
		window.__opens = window.__opens ?? {}
		window.__openDone = window.__openDone ?? {}
		window.__openDone[key] = false
		window.__opens[key] = this.open(key, dbName, opts).then((r) => {
			window.__openDone[key] = true
			return r
		})
		return true
	},
	openDone(key) {
		return window.__openDone?.[key] === true
	},
	/** Insert with a caller-chosen request id (a retried request reuses it). */
	async insertWithId(key, title, requestId, rowId) {
		const a = adapters.get(key)
		try {
			await a.execute(
				'INSERT OR IGNORE INTO notes (id, title, _created_at, _updated_at) VALUES (?, ?, ?, ?)',
				[rowId ?? crypto.randomUUID(), title, Date.now(), Date.now()],
				{ requestId },
			)
			return { ok: true }
		} catch (e) {
			return { ok: false, error: String(e?.message ?? e), name: e?.name }
		}
	},
	awaitOpen(key) {
		return window.__opens[key]
	},
	/** Names and holders of every Web Lock on the origin (tabs and workers). */
	async locks() {
		const s = await navigator.locks.query()
		return {
			held: (s.held ?? []).map((l) => l.name),
			pending: (s.pending ?? []).map((l) => l.name),
		}
	},
	/** Top-level OPFS entries (pool directories are `.kora-opfs*`). */
	async opfsEntries() {
		const root = await navigator.storage.getDirectory()
		const names = []
		for await (const [name] of root.entries()) names.push(name)
		return names.sort()
	},
	poolNameFor(dbName) {
		return sqliteWasm.opfsPoolNameFor(dbName)
	},
	async listDatabases() {
		return (await sqliteWasm.listLocalDatabases()).map((r) => ({
			dbName: r.dbName,
			backend: r.backend,
			poolName: r.poolName,
		}))
	},
	async deleteDatabase(dbName, opts = {}) {
		try {
			const deleted = await sqliteWasm.deleteLocalDatabase(dbName, {
				workerUrl: '/kora-worker.js',
				force: opts.force === true,
				hasUnsyncedOperations: async (db) => {
					const rows = await db.query('SELECT COUNT(*) AS n FROM notes')
					return opts.unsyncedWhenRows === true && rows[0].n > 0
				},
			})
			return { ok: true, deleted }
		} catch (e) {
			return { ok: false, name: e?.name, code: e?.code, error: String(e?.message ?? e) }
		}
	},
	// ---- frozen beta.12 worker (legacy origin-wide pool) ----
	legacy: {},
	async legacyOpen(key, dbName) {
		const w = new Worker('/beta12-worker.js', { type: 'module' })
		let n = 0
		const pending = new Map()
		w.onmessage = (e) => {
			const p = pending.get(e.data.id)
			if (p) {
				pending.delete(e.data.id)
				p(e.data)
			}
		}
		const call = (req) =>
			new Promise((r) => {
				const id = ++n
				pending.set(id, r)
				w.postMessage({ ...req, id })
			})
		this.legacy[key] = { w, call }
		return call({ type: 'open', ddlStatements: generateFullDDL(schema), dbName })
	},
	legacyInsert(key, title) {
		return this.legacy[key].call({
			type: 'execute',
			sql: 'INSERT INTO notes (id, title, _created_at, _updated_at) VALUES (?, ?, ?, ?)',
			params: [crypto.randomUUID(), title, Date.now(), Date.now()],
		})
	},
	legacyKill(key) {
		this.legacy[key]?.w.terminate()
		delete this.legacy[key]
		return true
	},
}
window.__ready = true
