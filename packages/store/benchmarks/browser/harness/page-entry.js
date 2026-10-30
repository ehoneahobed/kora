// STORE-16 browser benchmark page: the BUILT @korajs/store on a real dedicated worker,
// real SQLite WASM and real OPFS (opfs-sahpool), plus the IndexedDB fallback with its
// real snapshot persistence. Each scenario returns raw timings; the runner gates them.
import { defineSchema, t } from '../../../../core/dist/index.js'
import { IndexedDbAdapter } from '../../../dist/adapters/indexeddb.js'
import { SqliteWasmAdapter } from '../../../dist/adapters/sqlite-wasm.js'
import { Store } from '../../../dist/index.js'
import {
	PhaseTimers,
	installPhaseTimers,
	summarizePhases,
	summarizeSamples,
} from '../../../dist/internal.js'

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

async function openIndexedDbStore(dbName, persistenceDebounceMs = 60_000) {
	const adapter = new IndexedDbAdapter({ dbName, workerUrl: WORKER_URL, persistenceDebounceMs })
	const store = new Store({ schema: todoSchema, adapter, dbName, nodeId: unique('crash-node') })
	await store.open()
	return { store, adapter }
}

async function insertMany(store, n) {
	await store.transaction(async (tx) => {
		const todos = tx.collection('todos')
		for (let i = 0; i < n; i++) {
			await todos.insert({ title: `todo-${i}`, completed: i % 10 === 0 })
		}
	})
}

/** C3: the same rows through `collection.insertMany` on a fresh OPFS database (null before C3). */
async function measureInsertMany(n) {
	const { store } = await openStore('opfs', todoSchema)
	try {
		const todos = store.collection('todos')
		if (typeof todos.insertMany !== 'function') return null
		const rows = []
		for (let i = 0; i < n; i++) rows.push({ title: `todo-${i}`, completed: i % 10 === 0 })
		const t0 = performance.now()
		await todos.insertMany(rows)
		return performance.now() - t0
	} finally {
		await store.close()
	}
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

/**
 * S0: wait until the open record has seen `expectedRereads` subscription re-runs (and at
 * least one callback), then one more task so the flush chain is fully drained.
 */
async function drainRecord(timers, expectedRereads) {
	for (;;) {
		const open = timers.peek()
		if (open && open.callbacks > 0 && open.rereads >= expectedRereads) break
		await nextTask()
	}
	await nextTask()
}

/** Summarize finished records of one kind: per-phase p50/p95 plus the write-to-callback metric. */
function summarizeRecords(records, resolveMs) {
	return {
		samples: records.length,
		phases: summarizePhases(records),
		writeToCallback: summarizeSamples(
			records.map((record) => (record.firstCallbackAt ?? record.startedAt) - record.startedAt),
		),
		writeToResolve: summarizeSamples(resolveMs),
		rereads: summarizeSamples(records.map((record) => record.rereads)),
	}
}

async function measureKind(timers, kind, count, expectedRereads, run) {
	const resolveMs = []
	for (let i = 0; i < count; i++) {
		const start = performance.now()
		await run(i)
		resolveMs.push(performance.now() - start)
		await drainRecord(timers, expectedRereads)
	}
	return summarizeRecords(
		timers.take().filter((record) => record.kind === kind),
		resolveMs,
	)
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
			const insertManyMs = await measureInsertMany(rows)
			return {
				openMs,
				persistent: state?.persistent ?? null,
				mode: state?.mode ?? null,
				journalMode: state?.journalMode ?? null,
				insertMs,
				insertManyMs,
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

	/**
	 * S0: where write-to-callback latency goes (prepare, tx open, body, commit, publish,
	 * flush delay, re-read, diff and callback) for insert, update and delete, on OPFS with
	 * ~5k rows and one active subscription, then for the 1,000-subscription fan-out.
	 * `instantUpdates` is accepted and recorded; it is a no-op until stage S4.
	 */
	async phases({
		rows = 5_000,
		samples = 40,
		fanoutSubscriptions = 1_000,
		fanoutRowsPerCollection = 100,
		fanoutMutations = 30,
		instantUpdates = false,
	} = {}) {
		const timers = new PhaseTimers()
		const out = { rows, instantUpdates, instantUpdatesEffective: false }
		{
			const { store } = await openStore('opfs', todoSchema)
			try {
				await store.transaction(async (tx) => {
					const col = tx.collection('todos')
					for (let i = 0; i < rows; i++) {
						await col.insert({ title: `todo-${i}`, completed: i % 5 === 0 })
					}
				})
				const todos = store.collection('todos')
				let calls = 0
				let lastLength = 0
				const unsubscribe = todos.where({ completed: true }).subscribe((list) => {
					calls++
					lastLength = list.length
				})
				while (calls === 0) await nextTask()
				out.subscriptionRows = lastLength
				// Records to update and delete: rows inside the subscription's result.
				const inResult = await todos
					.where({ completed: true })
					.limit(samples * 2)
					.exec()
				const toUpdate = inResult.slice(0, samples)
				const toDelete = inResult.slice(samples, samples * 2)
				// Warm up so JIT, the sequence block and OPFS page allocation are not measured.
				for (let i = 0; i < 5; i++) {
					await todos.insert({ title: `warm-${i}`, completed: true })
					await nextTask()
				}
				await store.getSubscriptionManager().flush()
				await nextTask()
				installPhaseTimers(timers)
				out.single = {
					insert: await measureKind(timers, 'insert', samples, 1, (i) =>
						todos.insert({ title: `live-${i}`, completed: true }),
					),
					update: await measureKind(timers, 'update', samples, 1, (i) =>
						todos.update(toUpdate[i].id, { title: `edited-${i}` }),
					),
					delete: await measureKind(timers, 'delete', samples, 1, (i) =>
						todos.delete(toDelete[i].id),
					),
				}
				installPhaseTimers(null)
				unsubscribe()
			} finally {
				installPhaseTimers(null)
				await store.close()
			}
		}
		{
			const { store } = await openStore('opfs', fanoutSchema)
			try {
				await store.transaction(async (tx) => {
					for (let c = 0; c < FANOUT_COLLECTIONS; c++) {
						const col = tx.collection(`items${c}`)
						for (let i = 0; i < fanoutRowsPerCollection; i++) {
							await col.insert({ title: `t${i}`, bucket: `b${i % 50}` })
						}
					}
				})
				const perCollection = fanoutSubscriptions / FANOUT_COLLECTIONS
				let initial = 0
				for (let c = 0; c < FANOUT_COLLECTIONS; c++) {
					for (let q = 0; q < perCollection; q++) {
						let first = true
						store
							.collection(`items${c}`)
							.where({ bucket: `b${q}` })
							.subscribe(() => {
								if (first) {
									first = false
									initial++
								}
							})
					}
				}
				while (initial < fanoutSubscriptions) await nextTask()
				for (let i = 0; i < 3; i++) {
					await store.collection('items0').insert({ title: `warm${i}`, bucket: 'b0' })
					await store.getSubscriptionManager().flush()
					await nextTask()
				}
				installPhaseTimers(timers)
				// Every insert lands in bucket b0 of its collection, so subscription 0 of that
				// collection changes; the other subscriptions of the collection re-run unchanged.
				out.fanout = {
					subscriptions: fanoutSubscriptions,
					affectedPerWrite: perCollection,
					insert: await measureKind(timers, 'insert', fanoutMutations, perCollection, (m) =>
						store
							.collection(`items${m % FANOUT_COLLECTIONS}`)
							.insert({ title: `new${m}`, bucket: 'b0' }),
					),
				}
				installPhaseTimers(null)
			} finally {
				installPhaseTimers(null)
				await store.close()
			}
		}
		return out
	},

	/** IndexedDB fallback: resolved writes include their durability barrier (A0). */
	async indexeddb({ sizes = [1_000, 10_000], writeSamples = 20 } = {}) {
		const out = []
		for (const rows of sizes) {
			const { store } = await openStore('indexeddb', todoSchema)
			try {
				const t0 = performance.now()
				await insertMany(store, rows)
				const insertAndPersistMs = performance.now() - t0
				const resolvedWriteMs = []
				for (let sample = 0; sample < writeSamples; sample++) {
					const startedAt = performance.now()
					await store.collection('todos').insert({ title: `durable-${sample}` })
					resolvedWriteMs.push(performance.now() - startedAt)
				}
				out.push({
					rows,
					insertAndPersistMs,
					resolvedWriteP50: percentile(resolvedWriteMs, 0.5),
					resolvedWriteP95: percentile(resolvedWriteMs, 0.95),
				})
			} finally {
				await store.close()
			}
		}
		return out
	},

	/** Prepare a write, then let the runner kill this page and its worker with page.reload(). */
	async prepareCrashAfterResolve(barrier) {
		const dbName = unique(`bench-crash-${barrier ? 'barrier' : 'control'}`)
		const opened = await openIndexedDbStore(dbName)
		if (!barrier) opened.adapter.ensureDurable = undefined
		const record = await opened.store.collection('todos').insert({ title: 'before-crash' })
		return { dbName, recordId: record.id }
	},

	/** Read the database in the fresh page after the previous worker was killed. */
	async readCrashRecord({ dbName, recordId }) {
		const reopened = await openIndexedDbStore(dbName)
		try {
			return (await reopened.store.collection('todos').findById(recordId)) !== null
		} finally {
			await reopened.store.close()
		}
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
