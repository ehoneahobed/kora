/**
 * Multi-tab SQLite storage coordination via `navigator.locks` and `BroadcastChannel`.
 *
 * One tab holds the exclusive `kora-leader-${dbName}` lock and owns the SQLite worker.
 * Other tabs send worker RPC over a named broadcast channel.
 */

import type { WorkerBridge, WorkerRequest, WorkerResponse } from '../adapters/sqlite-wasm-channel'
import { NoLeaderError, WorkerTimeoutError } from '../errors'

const RPC_REQUEST = 'kora-worker-request'
const RPC_RESPONSE = 'kora-worker-response'
const CLIENT_LEAVE = 'kora-client-leave'
const LEADER_PING = 'kora-leader-ping'
const LEADER_PONG = 'kora-leader-pong'

/** Default delay before a stalled follower RPC probes the leader for liveness. */
const DEFAULT_LIVENESS_PROBE_MS = 2000
/** Default idle budget for a client that owns an open transaction span. */
const DEFAULT_TRANSACTION_IDLE_TIMEOUT_MS = 10_000

interface RpcRequestMessage {
	type: typeof RPC_REQUEST
	requestId: string
	clientId: string
	request: WorkerRequest
}

interface RpcResponseMessage {
	type: typeof RPC_RESPONSE
	requestId: string
	response: WorkerResponse
}

interface ClientLeaveMessage {
	type: typeof CLIENT_LEAVE
	clientId: string
}

interface ReclaimingWorkerBridge extends WorkerBridge {
	reclaimClient(clientId: string, reason: string): void
}

export type TabStorageRole = 'leader' | 'follower'

export interface AcquireTabStorageOptions {
	/**
	 * Invoked when a follower is promoted to leader because the previous leader
	 * released the lock (its tab closed or crashed). The adapter uses this to
	 * rebuild its bridge as a leader. Never fires for a tab that started as leader.
	 */
	onPromote?: () => void
}

export interface TabStorageSession {
	role: TabStorageRole
	channelName: string
	/** Leader only: release the navigator lock when closing the database. */
	releaseLock?: () => Promise<void>
	/** Leader only: stop the broadcast RPC relay. */
	stopRelay?: () => void
	/**
	 * Follower only: resolves when this tab has been promoted to leader (the old
	 * leader released the lock). The adapter awaits nothing here directly; it reacts
	 * via {@link AcquireTabStorageOptions.onPromote}. Present so callers can cancel
	 * the promotion watch on close.
	 */
	cancelPromotionWatch?: () => void
}

/**
 * Returns whether multi-tab coordination APIs exist in this runtime.
 */
export function isMultiTabStorageSupported(): boolean {
	return (
		typeof globalThis !== 'undefined' &&
		typeof BroadcastChannel !== 'undefined' &&
		typeof navigator !== 'undefined' &&
		typeof navigator.locks?.request === 'function'
	)
}

/**
 * Resolve leader vs follower for a database name.
 * Without lock APIs, every instance is treated as leader (single-tab / Node).
 *
 * A follower additionally queues a blocking request for the same lock. When the
 * current leader releases it (its tab closed or crashed), the browser grants the
 * lock to this follower and {@link AcquireTabStorageOptions.onPromote} fires so the
 * adapter can rebuild itself as the new leader. This is the automatic failover
 * path; a leader that is merely throttled (backgrounded but alive) keeps the lock,
 * and followers stay resilient through the liveness probe on the RPC bridge.
 */
export async function acquireTabStorageSession(
	dbName: string,
	options?: AcquireTabStorageOptions,
): Promise<TabStorageSession> {
	const channelName = `kora-storage-${dbName}`
	const lockName = `kora-leader-${dbName}`

	if (!isMultiTabStorageSupported()) {
		return { role: 'leader', channelName }
	}

	return new Promise<TabStorageSession>((resolve) => {
		let releaseHeld: (() => void) | undefined

		void navigator.locks.request(lockName, { mode: 'exclusive', ifAvailable: true }, (lock) => {
			if (lock === null) {
				resolve(startFollowerSession(channelName, lockName, options))
				return
			}

			resolve({
				role: 'leader',
				channelName,
				releaseLock: async () => {
					releaseHeld?.()
				},
			})

			return new Promise<void>((release) => {
				releaseHeld = release
			})
		})
	})
}

/**
 * Builds a follower session and starts watching for promotion. The follower holds
 * a queued lock request; when it is finally granted (old leader gone), it becomes
 * the leader for the rest of its lifetime and notifies via `onPromote`.
 */
function startFollowerSession(
	channelName: string,
	lockName: string,
	options?: AcquireTabStorageOptions,
): TabStorageSession {
	let promoted = false
	let releasePromotedLock: (() => void) | undefined
	const abort = new AbortController()

	void navigator.locks
		.request(lockName, { mode: 'exclusive', signal: abort.signal }, () => {
			// Reaching here means the previous leader released the lock and this tab
			// won it. Hold it (never-resolving promise) so this tab is now the leader.
			promoted = true
			options?.onPromote?.()
			return new Promise<void>((release) => {
				releasePromotedLock = release
			})
		})
		.catch(() => {
			// AbortError when the tab closes before promotion. Nothing to do.
		})

	return {
		role: 'follower',
		channelName,
		cancelPromotionWatch: () => {
			if (promoted) {
				releasePromotedLock?.()
			} else {
				abort.abort()
			}
		},
	}
}

/**
 * Leader tab: forward follower RPC to the real worker bridge.
 */
export function startLeaderRpcRelay(channelName: string, bridge: WorkerBridge): () => void {
	const channel = new BroadcastChannel(channelName)

	const onMessage = (
		event: MessageEvent<RpcRequestMessage | ClientLeaveMessage | { type: typeof LEADER_PING }>,
	): void => {
		const data = event.data
		// Answer liveness probes immediately, without touching the worker, so a
		// follower can distinguish a slow-but-alive leader from an absent one.
		if (data?.type === LEADER_PING) {
			channel.postMessage({ type: LEADER_PONG })
			return
		}
		if (data?.type === CLIENT_LEAVE) {
			if (hasReclaimClient(bridge)) {
				bridge.reclaimClient(data.clientId, 'client-left')
			}
			return
		}
		if (data?.type !== RPC_REQUEST) {
			return
		}

		void bridge
			.send(data.request, data.clientId)
			.then((response) => {
				const msg: RpcResponseMessage = {
					type: RPC_RESPONSE,
					requestId: data.requestId,
					response,
				}
				channel.postMessage(msg)
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : 'Worker RPC failed'
				const msg: RpcResponseMessage = {
					type: RPC_RESPONSE,
					requestId: data.requestId,
					response: {
						id: data.request.id,
						type: 'error',
						message,
						code: 'LEADER_RPC_ERROR',
					},
				}
				channel.postMessage(msg)
			})
	}

	channel.addEventListener('message', onMessage)
	return () => {
		channel.removeEventListener('message', onMessage)
		channel.close()
	}
}

/**
 * Follower tab: proxy {@link WorkerBridge} over BroadcastChannel to the leader.
 */
export class FollowerBroadcastBridge implements WorkerBridge {
	private readonly channel: BroadcastChannel
	private readonly clientId = createClientId()
	private readonly onPageHide = (): void => {
		this.leaveLeader()
	}
	private readonly pending = new Map<
		string,
		{ resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }
	>()
	private readonly timeoutMs: number
	private readonly livenessProbeMs: number
	private terminated = false

	constructor(channelName: string, timeoutMs = 30000, livenessProbeMs = DEFAULT_LIVENESS_PROBE_MS) {
		this.timeoutMs = timeoutMs
		this.livenessProbeMs = Math.min(livenessProbeMs, timeoutMs)
		this.channel = new BroadcastChannel(channelName)
		if (typeof addEventListener === 'function') {
			addEventListener('pagehide', this.onPageHide)
		}
		this.channel.addEventListener('message', (event: MessageEvent<RpcResponseMessage>) => {
			const data = event.data
			if (data?.type !== RPC_RESPONSE) {
				return
			}
			const entry = this.pending.get(data.requestId)
			if (entry) {
				this.pending.delete(data.requestId)
				entry.resolve(data.response)
			}
		})
	}

	/**
	 * Readiness handshake: resolves `true` as soon as a live leader answers a ping,
	 * or `false` if none answers within the budget. The adapter calls this before
	 * its first RPC so a follower created before a leader relay is live retries the
	 * handshake instead of firing into the void and waiting out the full timeout.
	 */
	async waitForLeader(timeoutMs = 3000, attempts = 3): Promise<boolean> {
		const perAttempt = Math.max(50, Math.floor(timeoutMs / Math.max(1, attempts)))
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			if (this.terminated) {
				return false
			}
			if (await this.pingLeader(perAttempt)) {
				return true
			}
		}
		return false
	}

	/** Sends one liveness ping and resolves whether a leader answered in time. */
	private pingLeader(timeoutMs: number): Promise<boolean> {
		if (this.terminated) {
			return Promise.resolve(false)
		}
		return new Promise<boolean>((resolve) => {
			const onPong = (event: MessageEvent<{ type: string }>): void => {
				if (event.data?.type === LEADER_PONG) {
					cleanup()
					resolve(true)
				}
			}
			const cleanup = (): void => {
				clearTimeout(timer)
				this.channel.removeEventListener('message', onPong)
			}
			const timer = setTimeout(() => {
				cleanup()
				resolve(false)
			}, timeoutMs)
			this.channel.addEventListener('message', onPong)
			this.channel.postMessage({ type: LEADER_PING })
		})
	}

	async send(request: WorkerRequest): Promise<WorkerResponse> {
		if (this.terminated) {
			return {
				id: request.id,
				type: 'error',
				message: 'Follower bridge terminated',
				code: 'BRIDGE_TERMINATED',
			}
		}

		const requestId = createClientId()
		const msg: RpcRequestMessage = {
			type: RPC_REQUEST,
			requestId,
			clientId: this.clientId,
			request,
		}

		return new Promise<WorkerResponse>((resolve, reject) => {
			const settle = (fn: () => void): void => {
				clearTimeout(timer)
				clearTimeout(probe)
				this.pending.delete(requestId)
				fn()
			}

			const timer = setTimeout(() => {
				settle(() => reject(new WorkerTimeoutError(`follower-rpc:${request.type}`, this.timeoutMs)))
			}, this.timeoutMs)

			// Liveness watchdog: if the request stalls, probe the leader. A confirmed
			// absent leader fails fast (NoLeaderError) instead of waiting out the full
			// timeout; a slow-but-alive leader keeps its remaining time.
			const probe = setTimeout(() => {
				void this.pingLeader(this.livenessProbeMs).then((alive) => {
					if (!alive && this.pending.has(requestId)) {
						settle(() => reject(new NoLeaderError(`follower-rpc:${request.type}`)))
					}
				})
			}, this.livenessProbeMs)

			this.pending.set(requestId, {
				resolve: (response) => settle(() => resolve(response)),
				reject: (error) => settle(() => reject(error)),
			})

			this.channel.postMessage(msg)
		})
	}

	terminate(): void {
		if (this.terminated) {
			return
		}
		this.terminated = true
		this.leaveLeader()
		if (typeof removeEventListener === 'function') {
			removeEventListener('pagehide', this.onPageHide)
		}
		this.channel.close()
		for (const [, entry] of this.pending) {
			entry.reject(new Error('Follower bridge terminated'))
		}
		this.pending.clear()
	}

	private leaveLeader(): void {
		try {
			const message: ClientLeaveMessage = {
				type: CLIENT_LEAVE,
				clientId: this.clientId,
			}
			this.channel.postMessage(message)
		} catch {
			// Best effort: the serializer's idle rollback is the guaranteed backstop.
		}
	}
}

interface QueuedWorkerRequest {
	clientId: string
	request: WorkerRequest
	resolve: (response: WorkerResponse) => void
	reject: (error: Error) => void
}

/**
 * Serializes one SQLite worker across the leader tab and all follower tabs.
 *
 * SQLite transactions are represented as multiple worker messages
 * (`begin`, one or more reads/writes, then `commit`/`rollback`). Per-tab mutexes
 * cannot protect that span because follower messages converge at the leader.
 * This bridge promotes the worker boundary into the serialization point, so no
 * other client can interleave while a client owns an active transaction.
 */
export class TransactionSerializingWorkerBridge implements WorkerBridge {
	private readonly inner: WorkerBridge
	private readonly leaderClientId = createClientId()
	private readonly transactionIdleTimeoutMs: number
	private queue: QueuedWorkerRequest[] = []
	private activeTransactionClient: string | null = null
	private abortedClients = new Set<string>()
	private transactionIdleTimer: ReturnType<typeof setTimeout> | null = null
	private reclaiming = false
	private processing = false
	private terminated = false

	constructor(inner: WorkerBridge, transactionIdleTimeoutMs = DEFAULT_TRANSACTION_IDLE_TIMEOUT_MS) {
		this.inner = inner
		this.transactionIdleTimeoutMs = transactionIdleTimeoutMs
	}

	send(request: WorkerRequest, clientId = this.leaderClientId): Promise<WorkerResponse> {
		if (this.terminated) {
			return Promise.resolve({
				id: request.id,
				type: 'error',
				message: 'Worker has been terminated',
				code: 'WORKER_TERMINATED',
			})
		}
		if (this.abortedClients.has(clientId)) {
			if (request.type === 'begin') {
				this.abortedClients.delete(clientId)
			} else {
				return Promise.resolve({
					id: request.id,
					type: 'error',
					message: 'Previous transaction was aborted because the client stopped sending requests.',
					code: 'TRANSACTION_ABORTED',
				})
			}
		}

		return new Promise<WorkerResponse>((resolve, reject) => {
			this.queue.push({ clientId, request, resolve, reject })
			void this.processQueue()
		})
	}

	terminate(): void {
		if (this.terminated) {
			return
		}
		this.terminated = true
		this.clearTransactionIdleTimer()
		this.inner.terminate()
		const pending = this.queue.splice(0)
		for (const entry of pending) {
			entry.reject(new Error('Worker terminated'))
		}
	}

	reclaimClient(clientId: string, reason: string): void {
		if (this.terminated) {
			return
		}
		void this.reclaimClientNow(clientId, reason)
	}

	private async processQueue(): Promise<void> {
		if (this.processing || this.reclaiming) {
			return
		}
		this.processing = true
		try {
			while (!this.terminated) {
				const index = this.nextRunnableIndex()
				if (index === -1) {
					return
				}
				const [entry] = this.queue.splice(index, 1)
				if (!entry) {
					return
				}
				try {
					const response = await this.inner.send(entry.request)
					this.recordTransactionState(entry, response)
					entry.resolve(response)
				} catch (error) {
					this.resetFailedTransaction(entry)
					entry.reject(error instanceof Error ? error : new Error(String(error)))
				}
			}
		} finally {
			this.processing = false
			if (!this.terminated && !this.reclaiming && this.nextRunnableIndex() !== -1) {
				void this.processQueue()
			}
		}
	}

	private nextRunnableIndex(): number {
		if (this.queue.length === 0) {
			return -1
		}
		if (this.activeTransactionClient === null) {
			return 0
		}
		return this.queue.findIndex((entry) => entry.clientId === this.activeTransactionClient)
	}

	private recordTransactionState(entry: QueuedWorkerRequest, response: WorkerResponse): void {
		if (response.type === 'error') {
			this.resetFailedTransaction(entry)
			return
		}
		if (entry.request.type === 'begin') {
			this.activeTransactionClient = entry.clientId
			this.armTransactionIdleTimer(entry.clientId)
			return
		}
		if (this.activeTransactionClient === entry.clientId) {
			this.armTransactionIdleTimer(entry.clientId)
		}
		if (
			this.activeTransactionClient === entry.clientId &&
			(entry.request.type === 'commit' || entry.request.type === 'rollback')
		) {
			this.activeTransactionClient = null
			this.clearTransactionIdleTimer()
		}
	}

	private resetFailedTransaction(entry: QueuedWorkerRequest): void {
		if (this.activeTransactionClient === entry.clientId) {
			this.activeTransactionClient = null
			this.clearTransactionIdleTimer()
		}
	}

	private armTransactionIdleTimer(clientId: string): void {
		this.clearTransactionIdleTimer()
		this.transactionIdleTimer = setTimeout(() => {
			void this.reclaimClientNow(clientId, 'transaction-idle-timeout')
		}, this.transactionIdleTimeoutMs)
	}

	private clearTransactionIdleTimer(): void {
		if (this.transactionIdleTimer) {
			clearTimeout(this.transactionIdleTimer)
			this.transactionIdleTimer = null
		}
	}

	private async reclaimClientNow(clientId: string, reason: string): Promise<void> {
		if (this.reclaiming || this.activeTransactionClient !== clientId) {
			return
		}
		this.reclaiming = true
		this.clearTransactionIdleTimer()
		this.activeTransactionClient = null
		this.abortedClients.add(clientId)
		this.rejectQueuedClientRequests(clientId, reason)

		try {
			const response = await this.inner.send({ id: 0, type: 'rollback' })
			if (response.type === 'error') {
				// If there was no active SQLite transaction left, the important state
				// is already reclaimed in JS. The next request will establish a fresh
				// transaction if needed.
			}
		} catch {
			// Keep the queue moving. The inner worker will surface any unrecoverable
			// state through subsequent requests.
		} finally {
			this.reclaiming = false
			if (!this.terminated && this.nextRunnableIndex() !== -1) {
				void this.processQueue()
			}
		}
	}

	private rejectQueuedClientRequests(clientId: string, reason: string): void {
		const keep: QueuedWorkerRequest[] = []
		for (const entry of this.queue) {
			if (entry.clientId === clientId) {
				entry.resolve({
					id: entry.request.id,
					type: 'error',
					message: `Transaction client was reclaimed: ${reason}`,
					code: 'TRANSACTION_ABORTED',
				})
			} else {
				keep.push(entry)
			}
		}
		this.queue = keep
	}
}

function hasReclaimClient(bridge: WorkerBridge): bridge is ReclaimingWorkerBridge {
	return typeof (bridge as Partial<ReclaimingWorkerBridge>).reclaimClient === 'function'
}

function createClientId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID()
	}
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
