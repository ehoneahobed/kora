/// <reference lib="dom" />
import { WorkerTimeoutError } from '../errors'

// === Message Protocol ===

/**
 * Request message sent from the main thread to the SQLite WASM worker.
 * Each request carries a unique `id` for response correlation.
 */
export type WorkerRequest =
	| { id: number; type: 'open'; ddlStatements: string[] }
	| { id: number; type: 'close' }
	| { id: number; type: 'execute'; sql: string; params?: unknown[] }
	| { id: number; type: 'query'; sql: string; params?: unknown[] }
	| { id: number; type: 'begin' }
	| { id: number; type: 'commit' }
	| { id: number; type: 'rollback' }
	| { id: number; type: 'migrate'; from: number; to: number; statements: string[] }
	| { id: number; type: 'export' }

/**
 * Response message sent from the worker back to the main thread.
 * Matches the request `id` for correlation.
 */
export type WorkerResponse =
	| { id: number; type: 'success'; data?: unknown }
	| { id: number; type: 'error'; message: string; code: string; context?: Record<string, unknown> }

// === WorkerBridge Interface ===

/**
 * Abstraction over the communication channel with the SQLite WASM worker.
 * In browsers, this is backed by a real Web Worker via MessagePort.
 * In Node.js tests, this is backed by better-sqlite3 via MockWorkerBridge.
 */
export interface WorkerBridge {
	/** Send a request to the worker and wait for a response. */
	send(request: WorkerRequest): Promise<WorkerResponse>

	/** Terminate the worker. Safe to call multiple times. */
	terminate(): void
}

// === Mutex ===

/**
 * Async mutex for serializing transaction access across the async worker boundary.
 * Only one transaction may be active at a time.
 */
export class Mutex {
	private locked = false
	private waiters: Array<() => void> = []

	/**
	 * Acquire the mutex. Returns a release function.
	 * If the mutex is already held, the caller waits until it's released.
	 */
	async acquire(): Promise<() => void> {
		if (!this.locked) {
			this.locked = true
			return this.createRelease()
		}

		return new Promise<() => void>((resolve) => {
			this.waiters.push(() => {
				resolve(this.createRelease())
			})
		})
	}

	private createRelease(): () => void {
		let released = false
		return () => {
			if (released) return
			released = true
			const next = this.waiters.shift()
			if (next) {
				next()
			} else {
				this.locked = false
			}
		}
	}
}

// === WebWorkerBridge ===

/**
 * WorkerBridge implementation for browser environments.
 * Communicates with an actual Web Worker running SQLite WASM.
 */
export class WebWorkerBridge implements WorkerBridge {
	private worker: Worker
	private pending = new Map<
		number,
		{ resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }
	>()
	private nextId = 1
	private terminated = false
	private timeoutMs: number

	/**
	 * @param workerUrl - URL to the sqlite-wasm-worker script
	 * @param timeoutMs - Timeout for worker responses in milliseconds (default: 30000)
	 */
	constructor(workerUrl: string | URL, timeoutMs = 30000) {
		this.timeoutMs = timeoutMs
		this.worker = new Worker(workerUrl, { type: 'module' })
		this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
			const response = event.data
			const entry = this.pending.get(response.id)
			if (entry) {
				this.pending.delete(response.id)
				entry.resolve(response)
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

	async send(request: WorkerRequest): Promise<WorkerResponse> {
		if (this.terminated) {
			return {
				id: request.id,
				type: 'error',
				message: 'Worker has been terminated',
				code: 'WORKER_TERMINATED',
			}
		}

		const id = this.nextId++
		const req = { ...request, id }

		return new Promise<WorkerResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new WorkerTimeoutError(req.type, this.timeoutMs))
			}, this.timeoutMs)

			this.pending.set(id, {
				resolve: (response) => {
					clearTimeout(timer)
					resolve(response)
				},
				reject: (error) => {
					clearTimeout(timer)
					reject(error)
				},
			})

			this.worker.postMessage(req)
		})
	}

	terminate(): void {
		if (this.terminated) return
		this.terminated = true
		this.worker.terminate()
		// Reject any pending requests
		for (const [id, entry] of this.pending) {
			this.pending.delete(id)
			entry.reject(new Error('Worker terminated'))
		}
	}
}
