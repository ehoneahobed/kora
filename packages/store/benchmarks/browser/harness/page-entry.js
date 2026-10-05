// STORE-16 browser benchmark page: the BUILT @korajs/store on a real dedicated worker,
// real SQLite WASM and real OPFS (opfs-sahpool), plus the IndexedDB fallback with its
// real snapshot persistence. Each scenario returns raw timings; the runner gates them.
import { defineSchema, t } from '../../../../core/dist/index.js'
import { IndexedDbAdapter } from '../../../dist/adapters/indexeddb.js'
import { SqliteWasmAdapter } from '../../../dist/adapters/sqlite-wasm.js'
import { Store } from '../../../dist/index.js'

const WORKER_URL = '/kora-worker.js'
const todoSchema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), completed: t.boolean().default(false) } },
	},
})
const FANOUT_COLLECTIONS = 20
const fanoutCollections = {}
for (let c = 0; c < FANOUT_COLLECTIONS; c++) {
	fanoutCollections[`items${c}`] = { fields: { title: t.string(), bucket: t.string() } }
}
const fanoutSchema = defineSchema({ version: 1, collections: fanoutCollections })

const unique = (prefix) =>
	`${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))
const percentile = (samples, p) => {
	const sorted = [...samples].sort((a, b) => a - b)
	return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0
}

async function openStore(kind, schema) {
	const dbName = unique(`bench-${kind}`)
	const adapter =
		kind === 'indexeddb'
			? new IndexedDbAdapter({ dbName, workerUrl: WORKER_URL, persistenceDebounceMs: 0 })
			: new SqliteWasmAdapter({ dbName, workerUrl: WORKER_URL })
	const store = new Store({ schema, adapter, dbName, nodeId: 'bench-node' })
	const t0 = performance.now()
	await store.open()
	return { store, adapter, dbName, openMs: performance.now() - t0 }
}

async function insertMany(store, n) {
	await store.transaction(async (tx) => {
		const todos = tx.collection('todos')
		for (let i = 0; i < n; i++) {
			await todos.insert({ title: `todo-${i}`, completed: i % 10 === 0 })
		}
	})
}

async function reactiveLatency(store, samples) {
	const todos = store.collection('todos')
	let notifiedAt = 0
	let calls = 0
	const unsubscribe = todos.where({ completed: true }).subscribe(() => {
		calls++
		notifiedAt = performance.now()
	})
	while (calls === 0) await nextTask()
	const latencies = []
	for (let i = 0; i < samples; i++) {
		const before = calls
		const start = performance.now()
		await todos.insert({ title: `live-${i}`, completed: true })
		while (calls === before) await nextTask()
		latencies.push(notifiedAt - start)
	}
	unsubscribe()
	return latencies
}

window.B = {
	/** OPFS (sqlite-wasm adapter, real worker): open, inserts, query, reactive latency. */
	async opfs({ rows = 10_000, appPathInserts = 200, reactiveSamples = 30 } = {}) {
		const { store, adapter, openMs } = await openStore('opfs', todoSchema)
		try {
			const state = adapter.getStorageOpenState?.() ?? null
			const t0 = performance.now()
			await insertMany(store, rows)
			const insertMs = performance.now() - t0

			// App path: individual inserts (each its own write transaction + op log row).
			const todos = store.collection('todos')
			const t1 = performance.now()
			for (let i = 0; i < appPathInserts; i++) await todos.insert({ title: `single-${i}` })
			const perInsertMs = (performance.now() - t1) / appPathInserts

			const t2 = performance.now()
			const result = await todos.where({ completed: true }).exec()
			const queryMs = performance.now() - t2

			const latencies = await reactiveLatency(store, reactiveSamples)
			return {
				openMs,
				persistent: state?.persistent ?? null,
				mode: state?.mode ?? null,
				journalMode: state?.journalMode ?? null,
				insertMs,
				perInsertMs,
				queryMs,
				queryRows: result.length,
				reactiveP50: percentile(latencies, 0.5),
				reactiveP95: percentile(latencies, 0.95),
			}
		} finally {
			await store.close()
		}
	},

	/** IndexedDB fallback: inserts, then the snapshot persistence (durability barrier). */
	async indexeddb({ sizes = [1_000, 10_000] } = {}) {
		const out = []
		for (const rows of sizes) {
			const { store, adapter } = await openStore('indexeddb', todoSchema)
			try {
				const t0 = performance.now()
				await insertMany(store, rows)
				const insertMs = performance.now() - t0
				const t1 = performance.now()
				await adapter.ensureDurable()
				const persistMs = performance.now() - t1
				// One more small write: every snapshot re-writes the whole database.
				await store.collection('todos').insert({ title: 'one-more' })
				const t2 = performance.now()
				await adapter.ensureDurable()
				const persistAfterOneWriteMs = performance.now() - t2
				out.push({ rows, insertMs, persistMs, persistAfterOneWriteMs })
			} finally {
				await store.close()
			}
		}
		return out
	},

	/** 1,000 live queries over 20 collections on OPFS: check cost and notify latency. */
	async fanout({ subscriptions = 1_000, rowsPerCollection = 100, mutations = 40 } = {}) {
		const { store } = await openStore('opfs', fanoutSchema)
		try {
			await store.transaction(async (tx) => {
				for (let c = 0; c < FANOUT_COLLECTIONS; c++) {
					const col = tx.collection(`items${c}`)
					for (let i = 0; i < rowsPerCollection; i++) {
						await col.insert({ title: `t${i}`, bucket: `b${i % 50}` })
					}
				}
			})
			const perCollection = subscriptions / FANOUT_COLLECTIONS
			const notified = new Map()
			let initial = 0
			for (let c = 0; c < FANOUT_COLLECTIONS; c++) {
				for (let q = 0; q < perCollection; q++) {
					const key = `${c}:${q}`
					let first = true
					store
						.collection(`items${c}`)
						.where({ bucket: `b${q}` })
						.subscribe(() => {
							if (first) {
								first = false
								initial++
							}
							notified.set(key, performance.now())
						})
				}
			}
			while (initial < subscriptions) await nextTask()
			const manager = store.getSubscriptionManager()
			const before = manager.getStats()
			const latencies = []
			const affectedRerun = []
			for (let m = 0; m < mutations; m++) {
				const c = m % FANOUT_COLLECTIONS
				const watched = `${c}:${m % perCollection}`
				notified.delete(watched)
				const start = performance.now()
				await store
					.collection(`items${c}`)
					.insert({ title: `new${m}`, bucket: `b${m % perCollection}` })
				while (!notified.has(watched)) await nextTask()
				latencies.push(notified.get(watched) - start)
				await manager.flush()
				affectedRerun.push(performance.now() - start)
			}
			const after = manager.getStats()
			const checks = after.totalChecks - before.totalChecks
			const checkMs =
				(after.averageCheckTimeMs * after.totalChecks -
					before.averageCheckTimeMs * before.totalChecks) /
				Math.max(1, checks)
			return {
				subscriptions: manager.size,
				checkMs,
				notifyP50: percentile(latencies, 0.5),
				notifyP95: percentile(latencies, 0.95),
				affectedRerunP50: percentile(affectedRerun, 0.5),
			}
		} finally {
			await store.close()
		}
	},

	/** NEW-STORE-11: journal modes on opfs-sahpool (raw sqlite-wasm). */
	journalModes({ transactions = 300 } = {}) {
		return new Promise((resolve, reject) => {
			const worker = new Worker('/journal-worker.js', { type: 'module' })
			worker.onmessage = (event) => {
				if (event.data?.ready) {
					worker.postMessage({ id: 1, transactions })
					return
				}
				worker.terminate()
				if (event.data?.ok) resolve(event.data.data)
				else reject(new Error(event.data?.error ?? 'journal probe failed'))
			}
			worker.onerror = (event) => {
				worker.terminate()
				reject(new Error(event.message))
			}
		})
	},
}
window.__ready = true
