/**
 * Multi-tab SQLite storage coordination via `navigator.locks` and `BroadcastChannel`.
 *
 * One tab holds the exclusive `kora-leader-${dbName}` lock and owns the SQLite
 * worker. Other tabs send worker RPC over a named broadcast channel. In browsers
 * the leader's WORKER answers that channel itself ({@link startWorkerRpcRelay}),
 * so a hung leader main thread never blocks other tabs, and it pushes heartbeats
 * (also from inside long statements) that followers use to detect a hung or
 * frozen leader (NEW-STORE-9).
 */

import { leaderLockName, storageChannelName } from '../adapters/opfs-names'
import type {
	WorkerBridge,
	WorkerRequest,
	WorkerResponse,
	WorkerSendOptions,
} from '../adapters/sqlite-wasm-channel'
import {
	BridgeTerminatedError,
	LeaderUnresponsiveError,
	NoLeaderError,
	RequestAbortedError,
	WorkerTimeoutError,
} from '../errors'

const RPC_REQUEST = 'kora-worker-request'
const RPC_RESPONSE = 'kora-worker-response'
const CLIENT_LEAVE = 'kora-client-leave'
const LEADER_PING = 'kora-leader-ping'
const LEADER_PONG = 'kora-leader-pong'
const LEADER_HEARTBEAT = 'kora-leader-heartbeat'

/** Default interval between leader heartbeats and follower watchdog ticks. */
export const DEFAULT_HEARTBEAT_MS = 1000
/** Missed heartbeat intervals after which a follower gives up on a leader it heard. */
const MISSED_BEATS_UNRESPONSIVE = 3
/** Silent intervals after which a follower that never heard a leader gives up. */
const MISSED_BEATS_ABSENT = 2
/** Default idle budget for a client that owns an open transaction span. */
const DEFAULT_TRANSACTION_IDLE_TIMEOUT_MS = 10_000
/** Completed follower responses remembered for de-duplicating retried requests. */
const DEDUP_CAPACITY = 512

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

interface HeartbeatMessage {
	type: typeof LEADER_HEARTBEAT
	epoch: string
	source: 'main' | 'worker'
}

type ChannelMessage =
	| RpcRequestMessage
	| RpcResponseMessage
	| ClientLeaveMessage
	| HeartbeatMessage
	| { type: typeof LEADER_PING }
	| { type: typeof LEADER_PONG }

interface ReclaimingWorkerBridge extends WorkerBridge {
	reclaimClient(clientId: string, reason: string): void
}

export type TabStorageRole = 'leader' | 'follower'

export interface AcquireTabStorageOptions {
	/**
	 * Invoked when a follower is promoted to leader because the previous leader
	 * released the lock (its tab closed, crashed, or suspended itself on freeze).
	 * The adapter uses this to rebuild its bridge as a leader. Never fires for a
	 * tab that started as leader.
	 */
	onPromote?: () => void
}

export interface TabStorageSession {
	role: TabStorageRole
	channelName: string
	/** Leader only: release the navigator lock when closing the database. */
	releaseLock?: () => Promise<void>
	/** Leader only: stop the broadcast RPC relay or heartbeat. */
	stopRelay?: () => void
	/**
	 * Follower only: cancels the queued lock request (or, once promoted, releases
	 * the lock this tab won). Present so callers can tear the session down.
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
 * current leader releases it (its tab closed, crashed, or suspended on freeze),
 * the browser grants the lock to this follower and
 * {@link AcquireTabStorageOptions.onPromote} fires so the adapter can rebuild
 * itself as the new leader. Kora never uses the Web Locks `steal` option: a
 * frozen leader's worker would still hold the OPFS file handles.
 */
export async function acquireTabStorageSession(
	dbName: string,
	options?: AcquireTabStorageOptions,
): Promise<TabStorageSession> {
	const channelName = storageChannelName(dbName)
	const lockName = leaderLockName(dbName)

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
 * Answers follower RPC with a bounded response cache keyed by request id, so a
 * follower that retries a request it lost track of (leader looked unresponsive,
 * caller aborted) gets the original response instead of a second application.
 */
function createRequestDeduper(): {
	run(requestId: string, start: () => Promise<WorkerResponse>): Promise<WorkerResponse> | null
} {
	const inflight = new Map<string, Promise<WorkerResponse>>()
	const completed = new Map<string, WorkerResponse>()
	return {
		run(requestId, start) {
			const done = completed.get(requestId)
			if (done) return Promise.resolve(done)
			// Already running: the original response is broadcast when it lands.
			if (inflight.has(requestId)) return null
			const promise = start().then((response) => {
				inflight.delete(requestId)
				completed.set(requestId, response)
				if (completed.size > DEDUP_CAPACITY) {
					const oldest = completed.keys().next().value
					if (oldest !== undefined) completed.delete(oldest)
				}
				return response
			})
			inflight.set(requestId, promise)
			return promise
		},
	}
}

/** Options for the leader-side relays. */
export interface LeaderRelayOptions {
	/** Heartbeat interval; 0 disables heartbeats. */
	heartbeatMs?: number
}

/** Handle returned by {@link startWorkerRpcRelay}. */
export interface WorkerRpcRelay {
	/** Push a heartbeat now (called from inside long statements). */
	beat(): void
	stop(): void
}

function serveChannel(
	channel: BroadcastChannel,
	bridge: WorkerBridge,
	source: 'main' | 'worker',
	heartbeatMs: number,
): WorkerRpcRelay {
	const epoch = createClientId()
	const dedup = createRequestDeduper()
	const beat = (): void => {
		const message: HeartbeatMessage = { type: LEADER_HEARTBEAT, epoch, source }
		channel.postMessage(message)
	}
	const respond = (requestId: string, response: WorkerResponse): void => {
		const msg: RpcResponseMessage = { type: RPC_RESPONSE, requestId, response }
		channel.postMessage(msg)
	}

	const onMessage = (event: MessageEvent<ChannelMessage>): void => {
		const data = event.data
		// Answer liveness probes immediately, without touching the database.
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
		if (
			data.request.type === 'close' ||
			data.request.type === 'destroy' ||
			data.request.type === 'serve'
		) {
			// Only the owning tab may close or remove the database; a follower
			// leaving just stops sending requests.
			respond(data.requestId, { id: data.request.id, type: 'success' })
			return
		}

		const pending = dedup.run(data.requestId, () =>
			bridge.send(data.request, data.clientId).catch(
				(error: unknown): WorkerResponse => ({
					id: data.request.id,
					type: 'error',
					message: error instanceof Error ? error.message : 'Worker RPC failed',
					code: 'LEADER_RPC_ERROR',
				}),
			),
		)
		void pending?.then((response) => respond(data.requestId, response))
	}

	channel.addEventListener('message', onMessage)
	const interval = heartbeatMs > 0 ? setInterval(beat, heartbeatMs) : undefined
	if (heartbeatMs > 0) beat()
	return {
		beat,
		stop: () => {
			if (interval !== undefined) clearInterval(interval)
			channel.removeEventListener('message', onMessage)
			channel.close()
		},
	}
}

/**
 * Leader main thread: forward follower RPC to the worker bridge. Used where the
 * worker cannot host the relay itself (Node tests, custom bridges). Heartbeats
 * are off by default here; pass `heartbeatMs` to enable them.
 */
export function startLeaderRpcRelay(
	channelName: string,
	bridge: WorkerBridge,
	options: LeaderRelayOptions = {},
): () => void {
	return serveChannel(new BroadcastChannel(channelName), bridge, 'main', options.heartbeatMs ?? 0)
		.stop
}

/**
 * Leader WORKER: answer follower RPC, pings and heartbeats from inside the
 * dedicated SQLite worker, through the worker's transaction serializer. The
 * leader tab's main thread is not on this path, so a hung or busy main thread
 * does not stall other tabs (NEW-STORE-9).
 */
export function startWorkerRpcRelay(
	channelName: string,
	bridge: WorkerBridge,
	options: LeaderRelayOptions = {},
): WorkerRpcRelay {
	return serveChannel(
		new BroadcastChannel(channelName),
		bridge,
		'worker',
		options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
	)
}

interface PendingFollowerRequest {
	type: string
	resolve: (r: WorkerResponse) => void
	reject: (e: Error) => void
}

/**
 * Follower tab: proxy {@link WorkerBridge} over BroadcastChannel to the leader.
 *
 * A single watchdog runs while requests are pending. Any message from the leader
 * (heartbeat, pong, response) is a sign of life; when the leader goes quiet the
 * watchdog pings it, and after {@link MISSED_BEATS_UNRESPONSIVE} silent intervals
 * it fails every pending request with a typed, retriable
 * {@link LeaderUnresponsiveError} (or {@link NoLeaderError} if no leader was
 * heard at all) instead of waiting out the full RPC timeout.
 */
export class FollowerBroadcastBridge implements WorkerBridge {
	private readonly channel: BroadcastChannel
	private readonly clientId = createClientId()
	private readonly onPageHide = (): void => {
		this.leaveLeader()
	}
	private readonly pending = new Map<string, PendingFollowerRequest>()
	private readonly timeoutMs: number
	private readonly heartbeatMs: number
	private terminated = false
	private lastHeardAt = 0
	private heardSinceWatch = false
	private watchdog: ReturnType<typeof setInterval> | undefined

	/**
	 * @param channelName - Storage channel of the database
	 * @param timeoutMs - Hard ceiling per request (default 30s)
	 * @param heartbeatMs - Expected leader heartbeat interval, also the watchdog tick
	 */
	constructor(channelName: string, timeoutMs = 30000, heartbeatMs = DEFAULT_HEARTBEAT_MS) {
		this.timeoutMs = timeoutMs
		this.heartbeatMs = Math.max(10, Math.min(heartbeatMs, timeoutMs))
		this.channel = new BroadcastChannel(channelName)
		if (typeof addEventListener === 'function') {
			addEventListener('pagehide', this.onPageHide)
		}
		this.channel.addEventListener('message', (event: MessageEvent<ChannelMessage>) => {
			const data = event.data
			if (
				data?.type === LEADER_HEARTBEAT ||
				data?.type === LEADER_PONG ||
				data?.type === RPC_RESPONSE
			) {
				this.markHeard()
			}
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
	 * handshake instead of firing into the void.
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

	async send(
		request: WorkerRequest,
		_clientId?: string,
		options: WorkerSendOptions = {},
	): Promise<WorkerResponse> {
		if (this.terminated) {
			return {
				id: request.id,
				type: 'error',
				message: 'Follower bridge terminated',
				code: 'BRIDGE_TERMINATED',
			}
		}

		const requestId = request.requestId ?? createClientId()
		const signal = options.signal
		if (signal?.aborted) {
			throw new RequestAbortedError(request.type, requestId)
		}
		const msg: RpcRequestMessage = {
			type: RPC_REQUEST,
			requestId,
			clientId: this.clientId,
			request: { ...request, requestId },
		}
		const timeoutMs = options.timeoutMs ?? this.timeoutMs

		return new Promise<WorkerResponse>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined
			const onAbort = (): void => {
				settle(() => reject(new RequestAbortedError(request.type, requestId)))
			}
			const settle = (fn: () => void): void => {
				if (timer !== undefined) clearTimeout(timer)
				signal?.removeEventListener('abort', onAbort)
				this.pending.delete(requestId)
				this.stopWatchdogIfIdle()
				fn()
			}
			if (Number.isFinite(timeoutMs)) {
				timer = setTimeout(() => {
					settle(() => reject(new WorkerTimeoutError(`follower-rpc:${request.type}`, timeoutMs)))
				}, timeoutMs)
			}
			signal?.addEventListener('abort', onAbort, { once: true })

			this.pending.set(requestId, {
				type: request.type,
				resolve: (response) => settle(() => resolve(response)),
				reject: (error) => settle(() => reject(error)),
			})
			this.startWatchdog()
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
		for (const [, entry] of [...this.pending]) {
			entry.reject(new BridgeTerminatedError(entry.type, 'follower bridge terminated'))
		}
		this.pending.clear()
		this.stopWatchdog()
	}

	private markHeard(): void {
		this.lastHeardAt = Date.now()
		this.heardSinceWatch = true
	}

	private startWatchdog(): void {
		if (this.watchdog !== undefined) return
		// A recent beat means a leader is known to exist; otherwise the silence
		// clock starts now.
		const now = Date.now()
		this.heardSinceWatch = now - this.lastHeardAt < this.heartbeatMs * 2
		if (!this.heardSinceWatch) this.lastHeardAt = now
		this.watchdog = setInterval(() => this.checkLiveness(), this.heartbeatMs)
	}

	private stopWatchdogIfIdle(): void {
		if (this.pending.size === 0) this.stopWatchdog()
	}

	private stopWatchdog(): void {
		if (this.watchdog !== undefined) {
			clearInterval(this.watchdog)
			this.watchdog = undefined
		}
	}

	private checkLiveness(): void {
		if (this.pending.size === 0) {
			this.stopWatchdog()
			return
		}
		const silentMs = Date.now() - this.lastHeardAt
		const heard = this.heardSinceWatch
		const limit = this.heartbeatMs * (heard ? MISSED_BEATS_UNRESPONSIVE : MISSED_BEATS_ABSENT)
		if (silentMs >= limit) {
			for (const [requestId, entry] of [...this.pending]) {
				entry.reject(
					heard
						? new LeaderUnresponsiveError(`follower-rpc:${entry.type}`, silentMs, requestId)
						: new NoLeaderError(`follower-rpc:${entry.type}`),
				)
			}
			return
		}
		if (silentMs >= this.heartbeatMs) {
			// Pull a sign of life from leaders that do not push heartbeats.
			this.channel.postMessage({ type: LEADER_PING })
		}
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
			entry.reject(new BridgeTerminatedError(entry.request.type, 'worker terminated'))
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
