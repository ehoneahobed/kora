/**
 * Deterministic stand-ins for the browser coordination APIs the multi-tab storage and the
 * version gate use: Web Locks (with `query()`), `BroadcastChannel` (with per-tab delivery
 * control), dedicated SQLite workers sharing one "OPFS file" per database, and a page
 * lifecycle per tab. No timers: every grant and delivery is a microtask.
 */
import type { WorkerRequest, WorkerResponse } from '../../src/adapters/sqlite-wasm-channel'
import { MockWorkerBridge } from '../../src/adapters/sqlite-wasm-mock-bridge'
import {
	TransactionSerializingWorkerBridge,
	type WorkerRpcRelay,
	startWorkerRpcRelay,
} from '../../src/multi-tab/tab-storage'
import type {
	GateChannel,
	GateLock,
	GateLockManager,
	GateLockRequestOptions,
} from '../../src/multi-tab/version-gate'

interface LockRequest {
	name: string
	mode: 'exclusive' | 'shared'
	callback: (lock: GateLock | null) => unknown
	resolve: (value: unknown) => void
	reject: (error: unknown) => void
	signal?: AbortSignal
	onAbort?: () => void
}

interface HeldEntry {
	mode: 'exclusive' | 'shared'
	count: number
}

/** Web Locks with exclusive/shared modes, `ifAvailable`, abort signals and `query()`. */
export class MockLockManager implements GateLockManager {
	private readonly held = new Map<string, HeldEntry>()
	private readonly queues = new Map<string, LockRequest[]>()

	request(
		name: string,
		options: GateLockRequestOptions,
		callback: (lock: GateLock | null) => unknown,
	): Promise<unknown> {
		const mode = options.mode ?? 'exclusive'
		return new Promise<unknown>((resolve, reject) => {
			if (options.signal?.aborted) {
				reject(new DOMException('aborted', 'AbortError'))
				return
			}
			const request: LockRequest = { name, mode, callback, resolve, reject }
			const queue = this.queues.get(name) ?? []
			if (options.ifAvailable && !(queue.length === 0 && this.grantable(name, mode))) {
				queueMicrotask(() => {
					Promise.resolve()
						.then(() => callback(null))
						.then(resolve, reject)
				})
				return
			}
			if (options.signal) {
				const signal = options.signal
				request.signal = signal
				request.onAbort = () => {
					const pending = this.queues.get(name) ?? []
					const index = pending.indexOf(request)
					if (index !== -1) {
						pending.splice(index, 1)
						reject(new DOMException('aborted', 'AbortError'))
						this.pump(name)
					}
				}
				signal.addEventListener('abort', request.onAbort, { once: true })
			}
			queue.push(request)
			this.queues.set(name, queue)
			this.pump(name)
		})
	}

	async query(): Promise<{
		held: Array<{ name: string; mode: string }>
		pending: Array<{ name: string; mode: string }>
	}> {
		const held: Array<{ name: string; mode: string }> = []
		for (const [name, entry] of this.held) {
			for (let i = 0; i < entry.count; i += 1) held.push({ name, mode: entry.mode })
		}
		const pending: Array<{ name: string; mode: string }> = []
		for (const [name, queue] of this.queues) {
			for (const request of queue) pending.push({ name, mode: request.mode })
		}
		return { held, pending }
	}

	/** Whether any request holds `name`. */
	isHeld(name: string): boolean {
		return this.held.has(name)
	}

	/** Names currently held (test assertions). */
	heldNames(): string[] {
		return [...this.held.keys()]
	}

	private grantable(name: string, mode: 'exclusive' | 'shared'): boolean {
		const entry = this.held.get(name)
		if (!entry) return true
		return entry.mode === 'shared' && mode === 'shared'
	}

	private pump(name: string): void {
		const queue = this.queues.get(name)
		if (!queue) return
		while (queue.length > 0) {
			const next = queue[0]
			if (!next || !this.grantable(name, next.mode)) break
			queue.shift()
			if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort)
			const entry = this.held.get(name)
			if (entry) entry.count += 1
			else this.held.set(name, { mode: next.mode, count: 1 })
			this.grant(next)
		}
		if (queue.length === 0) this.queues.delete(name)
	}

	private grant(request: LockRequest): void {
		queueMicrotask(() => {
			let result: unknown
			try {
				result = request.callback({ name: request.name })
			} catch (error) {
				this.release(request.name)
				request.reject(error)
				return
			}
			Promise.resolve(result).then(
				(value) => {
					this.release(request.name)
					request.resolve(value)
				},
				(error: unknown) => {
					this.release(request.name)
					request.reject(error)
				},
			)
		})
	}

	private release(name: string): void {
		const entry = this.held.get(name)
		if (!entry) return
		entry.count -= 1
		if (entry.count <= 0) this.held.delete(name)
		this.pump(name)
	}
}

type Handler = (event: { data: unknown }) => void

/**
 * `BroadcastChannel` with an optional owner tag per instance. Delivery to a tag can be held
 * (queued) and released later, to model a tab that has not processed a message yet.
 */
export class MockBroadcastChannel implements GateChannel {
	static channels = new Map<string, Set<MockBroadcastChannel>>()
	static heldTags = new Set<string>()
	static backlog: Array<{ target: MockBroadcastChannel; data: unknown }> = []
	/** Every message posted (test assertions). */
	static posted: Array<{ name: string; from: string | undefined; data: unknown }> = []
	private readonly handlers = new Set<Handler>()
	private closed = false

	constructor(
		public readonly name: string,
		public readonly tag?: string,
	) {
		const set = MockBroadcastChannel.channels.get(name) ?? new Set()
		set.add(this)
		MockBroadcastChannel.channels.set(name, set)
	}

	static reset(): void {
		MockBroadcastChannel.channels.clear()
		MockBroadcastChannel.heldTags.clear()
		MockBroadcastChannel.backlog = []
		MockBroadcastChannel.posted = []
	}

	/** Queue messages to channels tagged `tag` until {@link release}. */
	static hold(tag: string): void {
		MockBroadcastChannel.heldTags.add(tag)
	}

	/** Deliver the messages held for `tag`, in order. */
	static release(tag: string): void {
		MockBroadcastChannel.heldTags.delete(tag)
		const due = MockBroadcastChannel.backlog.filter((entry) => entry.target.tag === tag)
		MockBroadcastChannel.backlog = MockBroadcastChannel.backlog.filter(
			(entry) => entry.target.tag !== tag,
		)
		for (const entry of due) entry.target.deliver(entry.data)
	}

	postMessage(data: unknown): void {
		if (this.closed) throw new Error('channel closed')
		MockBroadcastChannel.posted.push({ name: this.name, from: this.tag, data })
		const peers = [...(MockBroadcastChannel.channels.get(this.name) ?? [])]
		for (const peer of peers) {
			if (peer === this) continue
			if (peer.tag !== undefined && MockBroadcastChannel.heldTags.has(peer.tag)) {
				MockBroadcastChannel.backlog.push({ target: peer, data })
				continue
			}
			peer.deliver(data)
		}
	}

	addEventListener(_type: 'message', handler: Handler): void {
		this.handlers.add(handler)
	}

	removeEventListener(_type: 'message', handler: Handler): void {
		this.handlers.delete(handler)
	}

	close(): void {
		this.closed = true
		MockBroadcastChannel.channels.get(this.name)?.delete(this)
	}

	private deliver(data: unknown): void {
		if (this.closed) return
		for (const handler of [...this.handlers]) handler({ data })
	}
}

/**
 * One database file shared by every worker (OPFS): opened once, never closed by a worker.
 * Requests can be held per type to model a slow statement.
 */
export class SharedDatabaseFile {
	readonly bridge = new MockWorkerBridge()
	private opened = false

	async send(request: WorkerRequest): Promise<WorkerResponse> {
		if (request.type === 'open') {
			if (this.opened) return { id: request.id, type: 'success' }
			this.opened = true
			return this.bridge.send(request)
		}
		if (request.type === 'close' || request.type === 'destroy') {
			return { id: request.id, type: 'success' }
		}
		return this.bridge.send(request)
	}
}

/** What a mock worker received, for assertions. */
export interface WorkerLogEntry {
	url: string
	worker: number
	type: string
	clientId?: string
}

/**
 * Dedicated SQLite worker stand-in, installed as the global `Worker`. Each worker serializes
 * its requests over the database file of its `dbName` (from the `open` request) and, once
 * sent `serve`, answers follower RPC on the storage channel itself.
 */
export class MockSqliteWorker {
	static files = new Map<string, SharedDatabaseFile>()
	static log: WorkerLogEntry[] = []
	static created: MockSqliteWorker[] = []
	/** Runs before each request reaches the database (await it to model a slow request). */
	static intercept:
		| ((worker: MockSqliteWorker, request: WorkerRequest) => Promise<void> | void)
		| null = null
	private static nextId = 0
	readonly id = ++MockSqliteWorker.nextId
	onmessage: ((event: { data: unknown }) => void) | null = null
	onerror: ((event: { message: string }) => void) | null = null
	terminated = false
	private file: SharedDatabaseFile | null = null
	private readonly serializer: TransactionSerializingWorkerBridge
	private relay: WorkerRpcRelay | null = null
	private openSpan = false

	constructor(readonly url: string) {
		MockSqliteWorker.created.push(this)
		this.serializer = new TransactionSerializingWorkerBridge({
			send: async (request) => {
				const file = this.file
				if (!file) {
					return { id: request.id, type: 'error', message: 'not open', code: 'NOT_OPEN' }
				}
				await MockSqliteWorker.intercept?.(this, request)
				if (this.terminated) {
					return { id: request.id, type: 'error', message: 'terminated', code: 'WORKER_TERMINATED' }
				}
				if (request.type === 'begin') this.openSpan = true
				if (request.type === 'commit' || request.type === 'rollback') this.openSpan = false
				return file.send(request)
			},
			terminate: () => {},
		})
	}

	static reset(): void {
		MockSqliteWorker.files.clear()
		MockSqliteWorker.log = []
		MockSqliteWorker.created = []
		MockSqliteWorker.intercept = null
	}

	static fileFor(dbName: string): SharedDatabaseFile {
		let file = MockSqliteWorker.files.get(dbName)
		if (!file) {
			file = new SharedDatabaseFile()
			MockSqliteWorker.files.set(dbName, file)
		}
		return file
	}

	postMessage(message: WorkerRequest & { clientId?: string }): void {
		if (this.terminated) return
		const { clientId, ...request } = message
		MockSqliteWorker.log.push({
			url: this.url,
			worker: this.id,
			type: request.type,
			...(clientId ? { clientId } : {}),
		})
		if (request.type === 'open' && !this.file) {
			// `memory` (the IndexedDB fallback): a database of this worker only.
			this.file =
				request.storage === 'memory'
					? new SharedDatabaseFile()
					: MockSqliteWorker.fileFor(request.dbName ?? 'kora-db')
		}
		if (request.type === 'serve') {
			if (!this.relay) {
				this.relay = startWorkerRpcRelay(request.channelName, this.serializer, {
					heartbeatMs: 0,
					...(request.identity ? { identity: request.identity } : {}),
				})
			}
			this.reply({ id: request.id, type: 'success' })
			return
		}
		void this.serializer.send(request, clientId).then(
			(response) => this.reply(response),
			(error: unknown) =>
				this.reply({
					id: request.id,
					type: 'error',
					message: error instanceof Error ? error.message : String(error),
					code: 'WORKER_ERROR',
				}),
		)
	}

	terminate(): void {
		if (this.terminated) return
		this.terminated = true
		this.relay?.stop()
		this.relay = null
		// A terminated worker discards its uncommitted transaction.
		if (this.openSpan && this.file) {
			this.openSpan = false
			void this.file.send({ id: 0, type: 'rollback' })
		}
	}

	private reply(response: WorkerResponse): void {
		if (this.terminated) return
		queueMicrotask(() => this.onmessage?.({ data: response }))
	}
}

/** A monotonically increasing open-order counter shared by the simulated tabs. */
export function createOpenSeqCounter(): (dbName: string) => Promise<number> {
	const counters = new Map<string, number>()
	return async (dbName) => {
		const next = (counters.get(dbName) ?? 0) + 1
		counters.set(dbName, next)
		return next
	}
}

/** Let every pending microtask (and the ones they queue) run. */
export async function flushMicrotasks(rounds = 50): Promise<void> {
	for (let i = 0; i < rounds; i += 1) {
		await Promise.resolve()
	}
}

/** Resolve when `predicate` holds, polling microtasks then macrotasks (bounded). */
export async function waitUntil(predicate: () => boolean, label = 'condition'): Promise<void> {
	for (let i = 0; i < 2000; i += 1) {
		if (predicate()) return
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
	}
	throw new Error(`Timed out waiting for ${label}`)
}
