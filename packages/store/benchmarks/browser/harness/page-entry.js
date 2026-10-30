// STORE-16 browser benchmark page: the BUILT @korajs/store on a real dedicated worker,
// real SQLite WASM and real OPFS (opfs-sahpool), plus the IndexedDB fallback with its
// real snapshot persistence. Each scenario returns raw timings; the runner gates them.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { defineSchema, t } from '../../../../core/dist/index.js'
import { SimpleEventEmitter } from '../../../../core/dist/internal.js'
import { KoraProvider, useMutation, useQuery } from '../../../../react/dist/index.js'
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

/**
 * Count the writes the overlay declined to predict, by kind and reason. A declined write
 * takes the committed path, so it shows up as a slow sample; the tally says which ones.
 */
function tallyMisses(emitter) {
	const misses = {}
	emitter.on('store:write-pending', (event) => {
		if (event.predicted) return
		const key = `${event.kind}:${event.reason}`
		misses[key] = (misses[key] ?? 0) + 1
	})
	return misses
}

async function openStore(kind, schema, { instantUpdates = false, emitter } = {}) {
	const dbName = unique(`bench-${kind}`)
	const adapter =
		kind === 'indexeddb'
			? new IndexedDbAdapter({ dbName, workerUrl: WORKER_URL, persistenceDebounceMs: 0 })
			: new SqliteWasmAdapter({ dbName, workerUrl: WORKER_URL })
	const store = new Store({
		schema,
		adapter,
		dbName,
		nodeId: 'bench-node',
		...(emitter ? { emitter } : {}),
		...(instantUpdates ? { instantUpdates: true } : {}),
	})
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

/**
 * Reactive-notification latency: the call of `insert` to the FIRST subscriber callback it
 * causes, with each write fully drained (commit, re-read and any settle callback) before
 * the next starts. The first callback is recorded by the subscriber itself, so a settle
 * callback of an earlier write that lands during a later `await` cannot be mistaken for the
 * later write's notification (it inflated the on-mode numbers in a first version of this
 * metric). The phase timers are installed only to know when the write's re-run finished.
 */
async function reactiveLatency(store, samples) {
	const todos = store.collection('todos')
	let firstAt = null
	let calls = 0
	const unsubscribe = todos.where({ completed: true }).subscribe(() => {
		calls++
		if (firstAt === null) firstAt = performance.now()
	})
	while (calls === 0) await nextTask()
	const timers = new PhaseTimers()
	installPhaseTimers(timers)
	try {
		for (let i = 0; i < 5; i++) {
			await todos.insert({ title: `warm-${i}`, completed: true })
			await drainRecord(timers, 1)
		}
		timers.take()
		const latencies = []
		const resolved = []
		for (let i = 0; i < samples; i++) {
			firstAt = null
			const start = performance.now()
			await todos.insert({ title: `live-${i}`, completed: true })
			resolved.push(performance.now() - start)
			while (firstAt === null) await nextTask()
			latencies.push(firstAt - start)
			await drainRecord(timers, 1)
			timers.take()
		}
		return { latencies, resolved }
	} finally {
		installPhaseTimers(null)
		unsubscribe()
	}
}

/**
 * S0: wait until the open record has seen `expectedRereads` subscription re-runs (and at
 * least one callback), then one more task so the flush chain is fully drained.
 *
 * This is the ONLY correct way to wait for a write's re-runs to finish. A write's flush is
 * a scheduled microtask that takes the pending collections and then awaits every affected
 * subscription one after another through the worker. `SubscriptionManager.flush()` called
 * from outside returns at once when nothing is pending, which is exactly the state while
 * that scheduled flush is still awaiting its re-runs; it does NOT wait for them. A harness
 * that "drains" with `await manager.flush()` therefore starts the next write while the
 * previous write's re-runs are still queued in the worker, and those re-runs are then
 * counted against (and delay) the next sample.
 */
async function drainRecord(timers, expectedRereads) {
	for (;;) {
		const open = timers.peek()
		if (open && open.callbacks > 0 && open.rereads >= expectedRereads) break
		await nextTask()
	}
	await nextTask()
	// More re-runs than this write can cause means an earlier write's re-runs were still in
	// flight and are being counted here: the sample (and every later one) is contaminated,
	// and `>= expectedRereads` above would have let it start the next write too early.
	const open = timers.peek()
	if (open && open.rereads > expectedRereads) {
		throw new Error(
			`harness: a ${open.kind} write saw ${open.rereads} subscription re-runs, expected ${expectedRereads}; an earlier write's re-runs were still in flight (drain every write before starting the next)`,
		)
	}
}

/** Summarize finished records of one kind: per-phase p50/p95 plus the write-to-callback metric. */
function summarizeRecords(records, resolveMs) {
	return {
		samples: records.length,
		phases: summarizePhases(records),
		writeToCallback: summarizeSamples(
			records
				.filter((record) => record.firstCallbackAt !== null)
				.map((record) => record.firstCallbackAt - record.startedAt),
		),
		writeToResolve: summarizeSamples(resolveMs),
		rereads: summarizeSamples(records.map((record) => record.rereads)),
	}
}

/** Writes the overlay declined to predict (0 when the overlay is off): they commit like today. */
function declinedWrites(store) {
	const controller = store.getOverlayController()
	if (!controller) return 0
	let total = 0
	for (const count of controller.registry.misses.values()) total += count
	return total
}

async function measureKind(timers, kind, count, expectedRereads, run, store) {
	const resolveMs = []
	const declinedBefore = store ? declinedWrites(store) : 0
	for (let i = 0; i < count; i++) {
		const start = performance.now()
		await run(i)
		resolveMs.push(performance.now() - start)
		await drainRecord(timers, expectedRereads)
	}
	const summary = summarizeRecords(
		timers.take().filter((record) => record.kind === kind),
		resolveMs,
	)
	// Samples with no callback before the SQL re-run are in `samples` but the p95 above is
	// over the writes that called back: a declined write is reported separately, never hidden.
	summary.declined = store ? declinedWrites(store) - declinedBefore : 0
	return summary
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

			const { latencies } = await reactiveLatency(store, reactiveSamples)
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
	 * S5: the reactive-notification gate on its own, with instant updates on or off. Same data
	 * shape as `opfs()` (10,000 todos, 1,000 of them completed, one live query over those).
	 */
	async reactive({ kind = 'opfs', rows = 10_000, samples = 30, instantUpdates = false } = {}) {
		const emitter = new SimpleEventEmitter()
		const misses = tallyMisses(emitter)
		const { store } = await openStore(kind, todoSchema, { instantUpdates, emitter })
		try {
			await insertMany(store, rows)
			const { latencies, resolved } = await reactiveLatency(store, samples)
			return {
				kind,
				rows,
				resolvedP95: percentile(resolved, 0.95),
				instantUpdates,
				effective: store.getOverlayController() !== null,
				p50: percentile(latencies, 0.5),
				p95: percentile(latencies, 0.95),
				misses,
			}
		} finally {
			await store.close()
		}
	},

	/**
	 * S0: where write-to-callback latency goes (prepare, tx open, body, commit, publish,
	 * flush delay, re-read, diff and callback) for insert, update and delete, on OPFS with
	 * ~5k rows and one active subscription, then for the 1,000-subscription fan-out.
	 * With `instantUpdates` the store is built with the overlay on: the callback of a write
	 * then arrives from the prediction, before the commit.
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
		const out = { rows, instantUpdates, instantUpdatesEffective: false, misses: {} }
		{
			const emitter = new SimpleEventEmitter()
			out.misses = tallyMisses(emitter)
			const { store } = await openStore('opfs', todoSchema, { instantUpdates, emitter })
			out.instantUpdatesEffective = store.getOverlayController() !== null
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
				installPhaseTimers(timers)
				for (let i = 0; i < 5; i++) {
					await todos.insert({ title: `warm-${i}`, completed: true })
					await drainRecord(timers, 1)
				}
				timers.take()
				out.single = {
					insert: await measureKind(
						timers,
						'insert',
						samples,
						1,
						(i) => todos.insert({ title: `live-${i}`, completed: true }),
						store,
					),
					update: await measureKind(
						timers,
						'update',
						samples,
						1,
						(i) => todos.update(toUpdate[i].id, { title: `edited-${i}` }),
						store,
					),
					delete: await measureKind(
						timers,
						'delete',
						samples,
						1,
						(i) => todos.delete(toDelete[i].id),
						store,
					),
				}
				out.seededRows = store.getOverlayController()?.registry.seededRows ?? 0
				installPhaseTimers(null)
				unsubscribe()
			} finally {
				installPhaseTimers(null)
				await store.close()
			}
		}
		{
			const { store } = await openStore('opfs', fanoutSchema, { instantUpdates })
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
				// Drain every warm-up write completely: `flush()` returns at once while a flush
				// is already running, so waiting on it left ~150 warm-up re-runs in flight that
				// the first measured writes then counted and queued behind (S1 finding).
				installPhaseTimers(timers)
				for (let i = 0; i < 3; i++) {
					await store.collection('items0').insert({ title: `warm${i}`, bucket: 'b0' })
					await drainRecord(timers, perCollection)
				}
				timers.take()
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
	async fanout({
		subscriptions = 1_000,
		rowsPerCollection = 100,
		mutations = 40,
		instantUpdates = false,
	} = {}) {
		const { store } = await openStore('opfs', fanoutSchema, { instantUpdates })
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
			// First callback of each subscription since it was last cleared: a settle callback of an
			// earlier write must not overwrite the time of the callback the write itself caused.
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
							if (!notified.has(key)) notified.set(key, performance.now())
						})
				}
			}
			while (initial < subscriptions) await nextTask()
			const manager = store.getSubscriptionManager()
			// The phase timers are installed only to COUNT re-runs, so each sample can wait for
			// its write's whole flush chain (drainRecord) before the next write starts. Their
			// cost is a few performance.now() calls per write, not per subscription check.
			const timers = new PhaseTimers()
			installPhaseTimers(timers)
			try {
				// Warm-up (JIT, sequence block, OPFS pages), drained like a measured write.
				for (let w = 0; w < 3; w++) {
					await store.collection('items0').insert({ title: `warm${w}`, bucket: 'b0' })
					await drainRecord(timers, perCollection)
				}
				timers.take()
				notified.clear()
				const before = manager.getStats()
				const latencies = []
				const affectedRerun = []
				for (let m = 0; m < mutations; m++) {
					const c = m % FANOUT_COLLECTIONS
					const watched = `${c}:${m % perCollection}`
					const start = performance.now()
					await store
						.collection(`items${c}`)
						.insert({ title: `new${m}`, bucket: `b${m % perCollection}` })
					while (!notified.has(watched)) await nextTask()
					latencies.push(notified.get(watched) - start)
					// All `perCollection` affected re-runs, so the next sample starts on an idle worker.
					await drainRecord(timers, perCollection)
					notified.clear()
					affectedRerun.push(performance.now() - start)
				}
				const after = manager.getStats()
				const checks = after.totalChecks - before.totalChecks
				const checkMs =
					(after.averageCheckTimeMs * after.totalChecks -
						before.averageCheckTimeMs * before.totalChecks) /
					Math.max(1, checks)
				return {
					instantUpdates,
					effective: store.getOverlayController() !== null,
					subscriptions: manager.size,
					checkMs,
					notifyP50: percentile(latencies, 0.5),
					notifyP95: percentile(latencies, 0.95),
					affectedRerunP50: percentile(affectedRerun, 0.5),
				}
			} finally {
				installPhaseTimers(null)
			}
		} finally {
			await store.close()
		}
	},

	/**
	 * S5 (design 12.5): click to DOM, through @korajs/react against a real OPFS store.
	 *
	 * A 1,000-row list is rendered with `useQuery`; a button wired through `useMutation`
	 * inserts a row that belongs in it. Per sample, from `button.click()` (React's event
	 * path) to (a) the MutationObserver callback that sees the new <li> (the DOM write
	 * happened, measured at the first line of the callback) and (b) the next animation
	 * frame after that. The write's own promise and its SQL settle are drained before the
	 * next sample, so a sample never queues behind an earlier one.
	 */
	async reactDom({ rows = 1_000, samples = 40, instantUpdates = false } = {}) {
		const emitter = new SimpleEventEmitter()
		const misses = tallyMisses(emitter)
		const { store } = await openStore('opfs', todoSchema, { instantUpdates, emitter })
		const container = document.createElement('div')
		document.body.append(container)
		const root = createRoot(container)
		const timers = new PhaseTimers()
		try {
			await store.transaction(async (tx) => {
				const col = tx.collection('todos')
				for (let i = 0; i < rows; i++) await col.insert({ title: `row-${i}`, completed: true })
			})
			const todos = store.collection('todos')
			const query = todos.where({ completed: true })
			let nextTitle = ''
			let lastWrite = Promise.resolve()
			function App() {
				const list = useQuery(query)
				const add = useMutation((data) => {
					lastWrite = todos.insert(data)
					return lastWrite
				})
				return createElement(
					'div',
					null,
					createElement(
						'button',
						{
							id: 'add',
							type: 'button',
							onClick: () => add.mutate({ title: nextTitle, completed: true }),
						},
						'Add',
					),
					createElement(
						'ul',
						{ id: 'list' },
						list.map((todo) =>
							createElement('li', { key: todo.id, 'data-title': todo.title }, todo.title),
						),
					),
				)
			}
			root.render(createElement(KoraProvider, { store }, createElement(App)))
			while (container.querySelectorAll('li').length < rows) await nextTask()
			const button = container.querySelector('#add')
			const list = container.querySelector('#list')
			installPhaseTimers(timers)
			const domMs = []
			const frameMs = []
			for (let i = -5; i < samples; i++) {
				nextTitle = `dom-${i}`
				const seen = new Promise((resolve) => {
					const observer = new MutationObserver(() => {
						const at = performance.now()
						if (list.querySelector(`li[data-title="${nextTitle}"]`)) {
							observer.disconnect()
							resolve(at)
						}
					})
					observer.observe(list, { childList: true, subtree: true })
				})
				const start = performance.now()
				button.click()
				const domAt = await seen
				const frameAt = await new Promise((resolve) =>
					requestAnimationFrame(() => resolve(performance.now())),
				)
				if (i >= 0) {
					domMs.push(domAt - start)
					frameMs.push(frameAt - start)
				}
				await lastWrite
				await drainRecord(timers, 1)
				timers.take()
			}
			installPhaseTimers(null)
			return {
				instantUpdates,
				effective: store.getOverlayController() !== null,
				rows,
				samples,
				domP50: percentile(domMs, 0.5),
				domP95: percentile(domMs, 0.95),
				frameP50: percentile(frameMs, 0.5),
				frameP95: percentile(frameMs, 0.95),
				misses,
			}
		} finally {
			installPhaseTimers(null)
			root.unmount()
			container.remove()
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
