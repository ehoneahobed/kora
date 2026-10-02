/// <reference lib="dom" />
import { BridgeTerminatedError, RequestAbortedError, WorkerTimeoutError } from '../errors'

// === Message Protocol ===

/** Fields every request carries besides its type. */
interface RequestMeta {
	/** Correlates a worker response with its request on one postMessage channel. */
	id: number
	/**
	 * Stable id for de-duplication. A follower retrying a request (after a
	 * `LeaderUnresponsiveError`, say) sends the same id and the leader worker
	 * answers from its response cache instead of applying it twice.
	 */
	requestId?: string
}

/**
 * Request message sent from the main thread (or a follower tab) to the SQLite
 * WASM worker.
 */
export type WorkerRequest =
	| (RequestMeta & {
			type: 'open'
			ddlStatements: string[]
			dbName?: string
			/**
			 * `memory` opens an in-memory database without touching OPFS (the
			 * IndexedDB adapter persists snapshots itself). Defaults to `opfs`.
			 */
			storage?: 'opfs' | 'memory'
			/** Fail with `NOT_FOUND` instead of creating the database file. */
			mustExist?: boolean
	  })
	| (RequestMeta & { type: 'close' })
	| (RequestMeta & { type: 'destroy' })
	| (RequestMeta & { type: 'execute'; sql: string; params?: unknown[] })
	| (RequestMeta & { type: 'query'; sql: string; params?: unknown[] })
	| (RequestMeta & { type: 'begin' })
	| (RequestMeta & { type: 'commit' })
	| (RequestMeta & { type: 'rollback' })
	| (RequestMeta & { type: 'migrate'; from: number; to: number; statements: string[] })
	| (RequestMeta & { type: 'export' })
	| (RequestMeta & { type: 'import'; data: Uint8Array })
	| (RequestMeta & {
			/**
			 * Leader worker only: answer follower RPC, pings and heartbeats on this
			 * BroadcastChannel directly, so a hung leader main thread never blocks
			 * other tabs (NEW-STORE-9).
			 */
			type: 'serve'
			channelName: string
	  })

/**
 * Response message sent from the worker back to the main thread.
 * Matches the request `id` for correlation.
 */
export type WorkerResponse =
	| { id: number; type: 'success'; data?: unknown }
	| { id: number; type: 'error'; message: string; code: string; context?: Record<string, unknown> }

/**
 * Unsolicited status the worker reports while it works on a request, such as
 * waiting for another holder of the OPFS pool (a blocking state the app shows).
 */
export type WorkerStatusEvent =
	| {
			kind: 'storage-blocked'
			resource: 'pool' | 'legacy-pool'
			poolName: string
	  }
	| {
			kind: 'storage-unblocked'
			resource: 'pool' | 'legacy-pool'
			poolName: string
			waitedMs: number
	  }

/** Envelope for {@link WorkerStatusEvent}s on the worker's postMessage channel. */
export interface WorkerEventMessage {
	id: -1
	type: 'event'
	event: WorkerStatusEvent
}

/** Message the main thread posts to a dedicated worker. */
export type WorkerInboundMessage = WorkerRequest & { clientId?: string }

/** Per-request options accepted by bridges. */
export interface WorkerSendOptions {
	/** Cancels the wait for the response (the worker may still apply the request). */
	signal?: AbortSignal
	/** Overrides the bridge timeout for this request; `Infinity` disables it. */
	timeoutMs?: number
}

// === WorkerBridge Interface ===

/**
 * Abstraction over the communication channel with the SQLite WASM worker.
 * In browsers, this is backed by a real Web Worker via MessagePort.
 * In Node.js tests, this is backed by better-sqlite3 via MockWorkerBridge.
 */
export interface WorkerBridge {
	/** Send a request to the worker and wait for a response. */
	send(
		request: WorkerRequest,
		clientId?: string,
		options?: WorkerSendOptions,
	): Promise<WorkerResponse>

	/** Terminate the worker. Safe to call multiple times. */
	terminate(): void
}

// === Mutex ===

// The Mutex now lives in its own module so non-browser adapters (better-sqlite3)
// can serialize transactions without importing browser-worker code.
export { Mutex } from './mutex'

// === WebWorkerBridge ===

/** Options for {@link WebWorkerBridge}. */
export interface WebWorkerBridgeOptions {
	/** Receives status events (blocking state) the worker reports. */
	onEvent?: (event: WorkerStatusEvent) => void
}

/**
 * WorkerBridge implementation for browser environments.
 * Communicates with an actual Web Worker running SQLite WASM.
 */
export class WebWorkerBridge implements WorkerBridge {
	private worker: Worker
	private pending = new Map<
		number,
		{ resolve: (r: WorkerResponse) => void; reject: (e: Error) => void; type: string }
	>()
	private nextId = 1
	private terminated = false
	private timeoutMs: number

	/**
	 * @param workerUrl - URL to the sqlite-wasm-worker script
	 * @param timeoutMs - Timeout for worker responses in milliseconds (default: 30000)
	 * @param options - Status event listener
	 */
	constructor(workerUrl: string | URL, timeoutMs = 30000, options: WebWorkerBridgeOptions = {}) {
		this.timeoutMs = timeoutMs
		this.worker = new Worker(workerUrl, { type: 'module' })
		this.worker.onmessage = (event: MessageEvent<WorkerResponse | WorkerEventMessage>) => {
			const message = event.data
			if (message.type === 'event') {
				options.onEvent?.(message.event)
				return
			}
			const entry = this.pending.get(message.id)
			if (entry) {
				this.pending.delete(message.id)
				entry.resolve(message)
			}
		}
		this.worker.onerror = (event) => {
			// Reject all pending requests on worker error
			const error = new Error(`Worker error: ${event.message}`)
			for (const [id, entry] of this.pending) {
				this.pending.delete(id)
				entry.reject(error)
			}
		}
	}

	/** True once {@link terminate} ran. */
	isTerminated(): boolean {
		return this.terminated
	}

	/** Post a request without awaiting a response (fire-and-forget control messages). */
	post(request: WorkerRequest, clientId?: string): void {
		if (this.terminated) return
		const message: WorkerInboundMessage = { ...request, id: this.nextId++, clientId }
		this.worker.postMessage(message)
	}

	async send(
		request: WorkerRequest,
		clientId?: string,
		options: WorkerSendOptions = {},
	): Promise<WorkerResponse> {
		if (this.terminated) {
			return {
				id: request.id,
				type: 'error',
				message: 'Worker has been terminated',
				code: 'WORKER_TERMINATED',
			}
		}

		const id = this.nextId++
		const message: WorkerInboundMessage = { ...request, id, clientId }
		const timeoutMs = options.timeoutMs ?? this.timeoutMs
		const signal = options.signal
		if (signal?.aborted) {
			throw new RequestAbortedError(request.type, request.requestId ?? String(id))
		}

		return new Promise<WorkerResponse>((resolve, reject) => {
			const timer = Number.isFinite(timeoutMs)
				? setTimeout(() => {
						this.pending.delete(id)
						cleanup()
						reject(new WorkerTimeoutError(message.type, timeoutMs))
					}, timeoutMs)
				: undefined
			const onAbort = (): void => {
				this.pending.delete(id)
				cleanup()
				reject(new RequestAbortedError(request.type, request.requestId ?? String(id)))
			}
			const cleanup = (): void => {
				if (timer !== undefined) clearTimeout(timer)
				signal?.removeEventListener('abort', onAbort)
			}
			signal?.addEventListener('abort', onAbort, { once: true })

			this.pending.set(id, {
				type: request.type,
				resolve: (response) => {
					cleanup()
					resolve(response)
				},
				reject: (error) => {
					cleanup()
					reject(error)
				},
			})

			this.worker.postMessage(message)
		})
	}

	terminate(): void {
		if (this.terminated) return
		this.terminated = true
		// Terminating the worker releases its OPFS handles and the pool Web Lock it
		// holds; callers release the tab leader lock only after this (NEW-STORE-10).
		this.worker.terminate()
		for (const [id, entry] of this.pending) {
			this.pending.delete(id)
			entry.reject(new BridgeTerminatedError(entry.type, 'worker terminated'))
		}
	}
}
