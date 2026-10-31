/**
 * The page the browser first-sync harness loads (C1.0(b), docs/design/fast-first-sync.md).
 *
 * It runs the real `createApp` from `korajs` on the real SQLite WASM worker with OPFS storage
 * and the real WebSocket transport. The harness calls `boot()` (open the database, no sync),
 * optionally throttles the network over CDP, then calls `sync()`, which times a first sync
 * from `app.sync.connect()` the way the Node benchmark times `engine.start()`.
 */
import { createApp } from 'korajs'
import { lmsFirstSyncSchema } from '../../lms-first-sync-fixture'
import { type CollectionDigest, digestRows } from '../digest'

export interface BootConfig {
	syncUrl: string
	token: string
	db: string
	/**
	 * `reactive` (the createApp default): a live query registers a sync query subset, which
	 * makes the engine handshake again. `disabled`: live queries register nothing, like the
	 * Node benchmark, which subscribes on the store with no sync bridge.
	 */
	querySubsets: 'reactive' | 'disabled'
	/** Staged replication: the engine's default, off, or on for every multi-batch first sync. */
	bulk?: 'default' | 'off' | 'on'
	/** Log every `sync:*` event with its time to the console (adds overhead; off for measurements). */
	debugEvents?: boolean
}

export interface SyncExpectation {
	/** `full-scope` waits for the initial sync to finish; `first-home-row` stops at the first row. */
	until: 'full-scope' | 'first-home-row'
	school: string
	homeCollection: string
	collections: string[]
	homeRows: number
	digests: Record<string, CollectionDigest>
}

export interface BootResult {
	bootMs: number
	userAgent: string
	hardwareConcurrency: number
	storage: { persistence: string; durable: boolean }
	heapMiB: number | null
}

export interface SyncMetrics {
	handshakeMs: number | null
	firstBatchMs: number | null
	firstHomeRowMs: number | null
	homeCompleteMs: number | null
	/** Null when the run stopped at the first home row. */
	fullScopeMs: number | null
	operationsReceived: number
	batches: number
	/** JSON characters of every message the page received (the decoded, inflated size). */
	downJsonBytes: number
	longTaskCount: number
	longTaskTotalMs: number
	longTaskMaxMs: number
	/** Main-thread stalls from a 10 ms timer: gaps over 60 ms between ticks (the longtask API reports nothing in headless Chromium). */
	stallCount: number
	stallTotalMs: number
	stallMaxMs: number
	peakHeapMiB: number | null
	startHeapMiB: number | null
	/** Messages received by type: count and decoded characters. */
	messageTypes: Record<string, { count: number; bytes: number }>
	/** Requests the page sent to the SQLite worker during the sync, by request type. */
	workerRequests: Record<string, number>
	/** Rows differ from the server's in these collections (empty when the device matches). */
	mismatches: string[]
	/** Staging events during the sync, in order (`sync:staging-started`, `-merged`, `-discarded`). */
	staging: string[]
}

declare global {
	interface Window {
		__bench: {
			boot(config: BootConfig): Promise<BootResult>
			sync(expectation: SyncExpectation): Promise<SyncMetrics>
		}
	}
	interface Performance {
		memory?: { usedJSHeapSize: number }
	}
}

const heapMiB = (): number | null =>
	performance.memory ? performance.memory.usedJSHeapSize / (1024 * 1024) : null

// Wrap WebSocket before the app opens one: the first arrival of each message type and the
// decoded size of everything received. Reading the type is a prefix match, not a parse.
interface MessageStat {
	count: number
	firstAt: number
	bytes: number
}
const messageStats = new Map<string, MessageStat>()
let downJsonBytes = 0
const NativeWebSocket = window.WebSocket
class InstrumentedWebSocket extends NativeWebSocket {
	constructor(url: string | URL, protocols?: string | string[]) {
		super(url, protocols)
		this.addEventListener('message', (event: MessageEvent) => {
			const at = performance.now()
			const data: unknown = event.data
			if (typeof data !== 'string') return
			downJsonBytes += data.length
			const match = /"type":"([a-z-]+)"/.exec(data.slice(0, 160))
			const type = match?.[1] ?? 'unknown'
			const stat = messageStats.get(type)
			if (stat) {
				stat.count += 1
				stat.bytes += data.length
			} else messageStats.set(type, { count: 1, firstAt: at, bytes: data.length })
		})
	}
}
window.WebSocket = InstrumentedWebSocket

// Requests to the SQLite worker by type: how many storage round trips the sync cost.
const workerRequests = new Map<string, number>()
const nativePostMessage = Worker.prototype.postMessage
Worker.prototype.postMessage = function postMessage(this: Worker, ...args: unknown[]): void {
	const message: unknown = args[0]
	if (typeof message === 'object' && message !== null && 'type' in message) {
		const type = String((message as { type: unknown }).type)
		workerRequests.set(type, (workerRequests.get(type) ?? 0) + 1)
	}
	;(nativePostMessage as (...rest: unknown[]) => void).apply(this, args)
} as typeof Worker.prototype.postMessage

// Long tasks on the main thread (50 ms or more). Worker threads are not observable.
interface LongTask {
	startTime: number
	duration: number
}
const longTasks: LongTask[] = []
let longTaskObserver: PerformanceObserver | null = null
try {
	longTaskObserver = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			longTasks.push({ startTime: entry.startTime, duration: entry.duration })
		}
	})
	longTaskObserver.observe({ type: 'longtask', buffered: true })
} catch {
	// Long task timing is unavailable: the harness reports zero tasks and says so.
}

type App = ReturnType<typeof createApp>
let app: App | null = null

window.__bench = {
	async boot(config) {
		const started = performance.now()
		app = createApp({
			schema: lmsFirstSyncSchema,
			store: { workerUrl: '/kora-worker.js', name: config.db, workerResponseTimeoutMs: 120_000 },
			sync: {
				url: config.syncUrl,
				auth: async () => ({ token: config.token }),
				querySubsets: { mode: config.querySubsets },
				...(config.bulk === 'off' ? { bulkReplication: false } : {}),
				...(config.bulk === 'on' ? { bulkReplication: { minOperations: 0 } } : {}),
			},
		})
		if (config.debugEvents) {
			const events = app.events
			const emit = events.emit.bind(events)
			events.emit = (event) => {
				if (
					!/^(operation|query|merge|sync:received|sync:acknowledged|sync:initial-sync-progress|sync:diagnostics)/.test(
						event.type,
					)
				) {
					console.log(`[event ${performance.now().toFixed(0)}] ${event.type}`)
				}
				emit(event)
			}
		}
		await app.ready
		const info = app.storeInfo()
		return {
			bootMs: performance.now() - started,
			userAgent: navigator.userAgent,
			hardwareConcurrency: navigator.hardwareConcurrency,
			storage: { persistence: info.persistence, durable: info.durable },
			heapMiB: heapMiB(),
		}
	},

	async sync(expected) {
		if (app === null || app.sync === null) throw new Error('boot() first')
		const running = app
		const engine = running.getSyncEngine()
		if (engine === null) throw new Error('no sync engine')

		const staging: string[] = []
		for (const type of [
			'sync:staging-started',
			'sync:staging-merged',
			'sync:staging-discarded',
		] as const) {
			running.events.on(type, () => staging.push(type))
		}
		let firstBatchAt: number | null = null
		let operationsReceived = 0
		let batches = 0
		running.on('sync:received', (event) => {
			batches += 1
			operationsReceived += event.operations.length
			if (firstBatchAt === null) firstBatchAt = performance.now()
		})

		let started = 0
		let firstHomeRowAt: number | null = null
		let homeCompleteAt: number | null = null
		const home = running.collections[expected.homeCollection]
		if (home === undefined) throw new Error(`no collection ${expected.homeCollection}`)
		const unsubscribe = home.where({ schoolId: expected.school }).subscribe((rows) => {
			if (started === 0) return
			const now = performance.now()
			if (rows.length > 0 && firstHomeRowAt === null) firstHomeRowAt = now
			if (rows.length >= expected.homeRows && homeCompleteAt === null) homeCompleteAt = now
		})

		const startHeap = heapMiB()
		let peakHeap = startHeap
		let lastTick = performance.now()
		let stallCount = 0
		let stallTotalMs = 0
		let stallMaxMs = 0
		const stallTimer = setInterval(() => {
			const now = performance.now()
			const gap = now - lastTick - 10
			lastTick = now
			if (gap > 50) {
				stallCount += 1
				stallTotalMs += gap
				stallMaxMs = Math.max(stallMaxMs, gap)
			}
		}, 10)
		const heapTimer = setInterval(() => {
			const now = heapMiB()
			if (now !== null && (peakHeap === null || now > peakHeap)) peakHeap = now
		}, 50)

		// Longtask entries and message stats before this point belong to boot.
		longTaskObserver?.takeRecords()
		messageStats.clear()
		downJsonBytes = 0
		longTasks.length = 0
		workerRequests.clear()

		started = performance.now()
		await running.sync?.connect()
		const deadline = started + 30 * 60_000
		const reached = (): boolean =>
			expected.until === 'first-home-row'
				? firstHomeRowAt !== null
				: engine.getState() === 'streaming'
		while (!reached()) {
			if (performance.now() > deadline) throw new Error('first sync did not complete in 30 minutes')
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
		const finished = performance.now()
		clearInterval(heapTimer)
		clearInterval(stallTimer)
		// Long task entries are delivered asynchronously.
		await new Promise((resolve) => setTimeout(resolve, 150))
		if (longTaskObserver) {
			for (const entry of longTaskObserver.takeRecords()) {
				longTasks.push({ startTime: entry.startTime, duration: entry.duration })
			}
		}
		const inWindow = longTasks.filter(
			(task) => task.startTime >= started && task.startTime <= finished,
		)
		unsubscribe()

		// Correctness (untimed): the device holds the server's records with its values.
		const mismatches: string[] = []
		for (const collection of expected.until === 'full-scope' ? expected.collections : []) {
			const accessor = running.collections[collection]
			if (accessor === undefined) {
				mismatches.push(collection)
				continue
			}
			const rows = (await accessor.where({}).exec()) as Array<Record<string, unknown>>
			const digest = digestRows(rows)
			const want = expected.digests[collection]
			if (want === undefined || digest.count !== want.count || digest.sum !== want.sum) {
				mismatches.push(collection)
			}
		}

		const handshakeAt = messageStats.get('handshake-response')?.firstAt
		return {
			handshakeMs: handshakeAt === undefined ? null : handshakeAt - started,
			firstBatchMs: firstBatchAt === null ? null : firstBatchAt - started,
			firstHomeRowMs: firstHomeRowAt === null ? null : firstHomeRowAt - started,
			homeCompleteMs: homeCompleteAt === null ? null : homeCompleteAt - started,
			fullScopeMs: expected.until === 'full-scope' ? finished - started : null,
			operationsReceived,
			batches,
			downJsonBytes,
			longTaskCount: inWindow.length,
			longTaskTotalMs: inWindow.reduce((sum, task) => sum + task.duration, 0),
			stallCount,
			stallTotalMs,
			stallMaxMs,
			longTaskMaxMs: inWindow.reduce((max, task) => Math.max(max, task.duration), 0),
			peakHeapMiB: peakHeap,
			startHeapMiB: startHeap,
			messageTypes: Object.fromEntries(
				[...messageStats].map(([type, stat]) => [type, { count: stat.count, bytes: stat.bytes }]),
			),
			workerRequests: Object.fromEntries(workerRequests),
			mismatches,
			staging,
		}
	},
}
