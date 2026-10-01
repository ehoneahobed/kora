import { defineSchema, t } from '../../../../../core/dist/index.js'
import { SqliteWasmAdapter } from '../../../../dist/adapters/sqlite-wasm.js'
import { IndexedDbAdapter } from '../../../../dist/adapters/indexeddb.js'

const schema = defineSchema({ version: 1, collections: { notes: { fields: { title: t.string() } } } })
const events = []
const emitter = { emit: (e) => events.push(e), on: () => () => {} }
const adapters = new Map()

function rawWorker() {
	const w = new Worker('/raw-worker.js', { type: 'module' })
	let n = 0
	const pending = new Map()
	const ready = new Promise((r) => { w.addEventListener('message', function f(e) { if (e.data?.ready) { w.removeEventListener('message', f); r() } }) })
	w.addEventListener('message', (e) => { const p = pending.get(e.data?.id); if (p) { pending.delete(e.data.id); p(e.data) } })
	return { ready, terminate: () => w.terminate(), call: async (cmd, args) => { await ready; const id = ++n; return new Promise((r) => { pending.set(id, r); w.postMessage({ id, cmd, args }) }) } }
}

window.H = {
	events,
	raw: {},
	newRaw(key) { this.raw[key] = rawWorker(); return this.raw[key].ready.then(() => true) },
	rawCall(key, cmd, args) { return this.raw[key].call(cmd, args) },
	killRaw(key) { this.raw[key].terminate(); delete this.raw[key]; return true },
	async open(key, dbName, opts = {}) {
		const t0 = performance.now()
		const A = opts.indexeddb ? IndexedDbAdapter : SqliteWasmAdapter
		const a = new A({ dbName, workerUrl: '/kora-worker.js', emitter, workerResponseTimeoutMs: opts.timeoutMs ?? 30000 })
		adapters.set(key, a)
		try {
			await a.open(schema)
			return { ok: true, ms: performance.now() - t0, state: a.getStorageOpenState?.() ?? null, role: a.inner ? a.inner.tabSession?.role : a.tabSession?.role }
		} catch (e) { return { ok: false, error: String(e?.message ?? e), code: e?.context?.code } }
	},
	role(key) { const a = adapters.get(key); return (a.inner ?? a).tabSession?.role },
	async insert(key, title) {
		const a = adapters.get(key)
		const t0 = performance.now()
		try { await a.execute('INSERT INTO notes (id, title, _created_at, _updated_at) VALUES (?, ?, ?, ?)', [crypto.randomUUID(), title, Date.now(), Date.now()]); return { ok: true, ms: performance.now() - t0 } }
		catch (e) { return { ok: false, ms: performance.now() - t0, error: String(e?.message ?? e), name: e?.name } }
	},
	async titles(key) {
		const a = adapters.get(key)
		const t0 = performance.now()
		try { const rows = await a.query('SELECT title FROM notes ORDER BY title'); return { ok: true, titles: rows.map((r) => r.title), ms: performance.now() - t0 } }
		catch (e) { return { ok: false, ms: performance.now() - t0, error: String(e?.message ?? e), name: e?.name } }
	},
	async slow(key, n) {
		const a = adapters.get(key)
		const t0 = performance.now()
		try { const rows = await a.query('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c', [n]); return { ok: true, rows, ms: performance.now() - t0 } }
		catch (e) { return { ok: false, ms: performance.now() - t0, error: String(e?.message ?? e), name: e?.name } }
	},
	startSlow(key, n) { window.__slow = this.slow(key, n); return true },
	awaitSlow() { return window.__slow },
	async dbList(key) { const a = adapters.get(key); try { return await a.query('PRAGMA database_list') } catch (e) { return String(e) } },
	async close(key) { const a = adapters.get(key); try { await a.close(); return true } catch (e) { return String(e) } finally { adapters.delete(key) } },
	async flush(key) { const a = adapters.get(key); await a.flushPersistence?.(); return true },
}
window.__ready = true
