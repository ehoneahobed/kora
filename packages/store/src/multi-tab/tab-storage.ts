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

import {
	gatedLeaderIdentityLockPrefix,
	gatedLeaderLockName,
	leaderLockName,
	storageChannelName,
} from '../adapters/opfs-names'
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
/**
 * A follower asks the leader TAB (its main thread, which owns the IndexedDB snapshot
 * scheduler) for a strict snapshot. Deliberately not an {@link RPC_REQUEST}: the leader's
 * worker relay forwards those to SQLite, and a snapshot is not a database statement. The
 * answer travels as an ordinary {@link RPC_RESPONSE}, so the follower's pending-request,
 * heartbeat and watchdog machinery applies unchanged.
 */
const SNAPSHOT_BARRIER_REQUEST = 'kora-snapshot-barrier-request'

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
/**
 * Response code of a relay that refused a request bound to another relay's epoch:
 * the request belongs to a transaction whose BEGIN a previous leader worker
 * answered, so running it here would autocommit part of that transaction.
 */
const LEADER_CHANGED = 'LEADER_CHANGED'
/** Span binding for a BEGIN answered by a relay that reports no epoch (older build). */
const LEGACY_RELAY_EPOCH = 'legacy-relay'
/** Code of {@link BridgeTerminatedError}, carried in responses across the channel. */
const BRIDGE_TERMINATED = 'BRIDGE_TERMINATED'

interface RpcRequestMessage {
	type: typeof RPC_REQUEST
	requestId: string
	clientId: string
	request: WorkerRequest
	/**
	 * Epoch of the relay that answered this request's transaction BEGIN. A relay
	 * with another epoch (a different leader worker) refuses the request unrun.
	 */
	epoch?: string
}

interface RpcResponseMessage {
	type: typeof RPC_RESPONSE
	requestId: string
	response: WorkerResponse
	/** Epoch of the answering relay (one per leader worker). */
	epoch?: string
}

interface ClientLeaveMessage {
	type: typeof CLIENT_LEAVE
	clientId: string
}

interface HeartbeatMessage {
	type: typeof LEADER_HEARTBEAT
	epoch: string
	source: 'main' | 'worker'
	/**
	 * The leader tab's version gate identity (`{ build, format, openSeq, tabId }`). A
	 * heartbeat without one comes from a leader running a pre-gate build.
	 */
	identity?: unknown
}

interface SnapshotBarrierRequestMessage {
	type: typeof SNAPSHOT_BARRIER_REQUEST
	requestId: string
}

type ChannelMessage =
	| SnapshotBarrierRequestMessage
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
	/**
	 * Hold the gated-leader marker while this tab holds the leader lock (taken right after
	 * the grant, released with the leader lock), so other tabs' version gates can tell this
	 * leader from one running a pre-gate build.
	 */
	markGatedLeader?: boolean
	/**
	 * The leader's version gate identity, read when the leader lock is granted: the marker is
	 * also held under a name carrying it ({@link gatedLeaderIdentityLockPrefix}).
	 */
	gatedLeaderIdentity?: () => unknown
}

/**
 * Take the gated-leader marker of `dbName`; the returned function releases it. A no-op
 * function when the marker is not wanted.
 */
function holdGatedLeaderMarker(
	dbName: string,
	options: AcquireTabStorageOptions | undefined,
): () => void {
	if (!options?.markGatedLeader) return () => {}
	let release: () => void = () => {}
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	void navigator.locks
		.request(gatedLeaderLockName(dbName), { mode: 'exclusive' }, () => held)
		.catch(() => undefined)
	const identity = options.gatedLeaderIdentity?.()
	if (identity !== undefined && identity !== null) {
		void navigator.locks
			.request(
				`${gatedLeaderIdentityLockPrefix(dbName)}${JSON.stringify(identity)}`,
				{ mode: 'exclusive' },
				() => held,
			)
			.catch(() => undefined)
	}
	return release
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

		const request = navigator.locks.request(
			lockName,
			{ mode: 'exclusive', ifAvailable: true },
			(lock) => {
				if (lock === null) {
					resolve(startFollowerSession(dbName, channelName, lockName, options))
					return
				}

				const releaseMarker = holdGatedLeaderMarker(dbName, options)
				resolve({
					role: 'leader',
					channelName,
					// Resolves once the lock manager released the lock, so a caller that releases
					// its version gate tab lock next does so after the leader lock.
					releaseLock: async () => {
						releaseHeld?.()
						releaseMarker()
						await request.catch(() => undefined)
					},
				})

				return new Promise<void>((release) => {
					releaseHeld = release
				})
			},
		)
	})
}

/**
 * Builds a follower session and starts watching for promotion. The follower holds
 * a queued lock request; when it is finally granted (old leader gone), it becomes
 * the leader for the rest of its lifetime and notifies via `onPromote`.
 */
function startFollowerSession(
	dbName: string,
	channelName: string,
	lockName: string,
	options?: AcquireTabStorageOptions,
): TabStorageSession {
	let promoted = false
	let releasePromotedLock: (() => void) | undefined
	let releaseMarker: () => void = () => {}
	const abort = new AbortController()

	void navigator.locks
		.request(lockName, { mode: 'exclusive', signal: abort.signal }, () => {
			// Reaching here means the previous leader released the lock and this tab
			// won it. Hold it (never-resolving promise) so this tab is now the leader.
			promoted = true
			releaseMarker = holdGatedLeaderMarker(dbName, options)
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
				releaseMarker()
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
	/** The leader tab's version gate identity, carried by every heartbeat. */
	identity?: unknown
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
	identity?: unknown,
): WorkerRpcRelay {
	const epoch = createClientId()
	const dedup = createRequestDeduper()
	const beat = (): void => {
		const message: HeartbeatMessage = {
			type: LEADER_HEARTBEAT,
			epoch,
			source,
			...(identity !== undefined ? { identity } : {}),
		}
		channel.postMessage(message)
	}
	const respond = (requestId: string, response: WorkerResponse): void => {
		const msg: RpcResponseMessage = { type: RPC_RESPONSE, requestId, response, epoch }
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
		if (data.epoch !== undefined && data.epoch !== epoch) {
			// The transaction this request belongs to began on another leader worker,
			// which rolled it back (or is gone). Running the request here would apply
			// it outside that transaction, so refuse it unrun.
			//
			// Assumes at most one relay is live per channel at a time. The leader lock
			// guarantees it: a leader terminates its worker (which stops the relay)
			// before it releases the lock, and the next leader starts its relay only
			// after it holds the lock. With two live relays, this refusal could reach
			// the follower before the matching relay's real answer, and a committed
			// transaction would be reported as a retriable failure.
			respond(data.requestId, {
				id: data.request.id,
				type: 'error',
				message: 'The storage leader changed during the transaction; the request was not run.',
				code: LEADER_CHANGED,
			})
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
					code: errorCode(error) ?? 'LEADER_RPC_ERROR',
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
	return serveChannel(
		new BroadcastChannel(channelName),
		bridge,
		'main',
		options.heartbeatMs ?? 0,
		options.identity,
	).stop
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
		options.identity,
	)
}

/**
 * What a follower needs to route its durability barrier to the leader tab: implemented
 * by {@link FollowerBroadcastBridge}.
 */
export interface SnapshotBarrierClient {
	requestSnapshotBarrier(options?: WorkerSendOptions): Promise<WorkerResponse>
}

/** Whether `bridge` can route a durability barrier to the leader tab. */
export function isSnapshotBarrierClient(bridge: unknown): bridge is SnapshotBarrierClient {
	return (
		typeof bridge === 'object' &&
		bridge !== null &&
		typeof (bridge as Partial<SnapshotBarrierClient>).requestSnapshotBarrier === 'function'
	)
}

/**
 * Leader TAB (main thread): answer followers' snapshot-barrier requests with `run`, which
 * saves a strict snapshot taken after the request arrived (the leader's persistence
 * scheduler, so every barrier waiting there shares it). Answers `success` once `run`
 * resolved and an error response, carrying the failure's `code` and message, when it threw.
 * A request id already running is answered by that run. Returns the function that stops
 * serving.
 */
export function serveSnapshotBarriers(channelName: string, run: () => Promise<void>): () => void {
	const channel = new BroadcastChannel(channelName)
	const epoch = createClientId()
	const running = new Set<string>()
	const onMessage = (event: MessageEvent<ChannelMessage>): void => {
		const data = event.data
		if (data?.type !== SNAPSHOT_BARRIER_REQUEST || running.has(data.requestId)) return
		running.add(data.requestId)
		const respond = (response: WorkerResponse): void => {
			running.delete(data.requestId)
			const msg: RpcResponseMessage = {
				type: RPC_RESPONSE,
				requestId: data.requestId,
				response,
				epoch,
			}
			channel.postMessage(msg)
		}
		run().then(
			() => respond({ id: 0, type: 'success' }),
			(error: unknown) =>
				respond({
					id: 0,
					type: 'error',
					message: error instanceof Error ? error.message : 'Snapshot barrier failed',
					code: errorCode(error) ?? 'SNAPSHOT_BARRIER_FAILED',
					context: errorContext(error),
				}),
		)
	}
	channel.addEventListener('message', onMessage)
	return () => {
		channel.removeEventListener('message', onMessage)
		channel.close()
	}
}

/** The structured-cloneable part of an error's context a follower needs to classify it. */
function errorContext(error: unknown): Record<string, unknown> | undefined {
	if (!(error instanceof Error)) return undefined
	const context = (error as { context?: Record<string, unknown> }).context
	const detail = context?.code
	const quota =
		context?.quotaExceeded === true ||
		error.name === 'QuotaExceededError' ||
		/quota/i.test(error.message)
	return {
		...(typeof detail === 'string' ? { detail } : {}),
		...(quota ? { quotaExceeded: true } : {}),
	}
}

interface PendingFollowerRequest {
	type: string
	/**
	 * Snapshot-barrier requests only: epoch of the leader relay whose heartbeat was last
	 * heard when the request was sent. A heartbeat of another epoch means the leader that
	 * received the request is gone and the successor never saw it.
	 */
	relayEpoch?: string
	resolve: (r: WorkerResponse, epoch?: string) => void
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
	/** Epoch of the leader relay whose heartbeat was heard last. */
	private lastRelayEpoch: string | undefined
	private watchdog: ReturnType<typeof setInterval> | undefined
	/**
	 * Epoch of the leader relay that answered the open transaction's BEGIN. Every
	 * later request of the span carries it, so a different leader worker refuses
	 * the request instead of autocommitting it outside the transaction.
	 */
	private spanEpoch: string | undefined

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
			if (data?.type === LEADER_HEARTBEAT) {
				this.noteRelayEpoch(data.epoch)
			}
			if (data?.type !== RPC_RESPONSE) {
				return
			}
			const entry = this.pending.get(data.requestId)
			if (entry) {
				this.pending.delete(data.requestId)
				entry.resolve(data.response, data.epoch)
			}
		})
	}

	/**
	 * A heartbeat names its relay's epoch (one per leader worker). A pending snapshot barrier
	 * was sent to the leader of the epoch heard then; once another epoch beats, that leader
	 * is gone and its successor never received the request, so the barrier fails fast
	 * (retriable) instead of waiting out the RPC timeout.
	 */
	private noteRelayEpoch(epoch: string): void {
		this.lastRelayEpoch = epoch
		for (const [, entry] of [...this.pending]) {
			if (entry.type !== 'snapshot-barrier') continue
			if (entry.relayEpoch === undefined) {
				entry.relayEpoch = epoch
			} else if (entry.relayEpoch !== epoch) {
				entry.reject(new BridgeTerminatedError('snapshot-barrier', 'the storage leader changed'))
			}
		}
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
		// Bind the request to the worker that answered the span's BEGIN. A BEGIN
		// starts a new span; a successful COMMIT or a ROLLBACK ends it. A relay
		// from an older build sends no epoch; the span is then bound to "a legacy
		// relay", which every relay that checks epochs refuses.
		const epoch = request.type === 'begin' || request.type === 'open' ? undefined : this.spanEpoch
		if (request.type === 'begin' || request.type === 'rollback') {
			this.spanEpoch = undefined
		}
		const msg: RpcRequestMessage = {
			type: RPC_REQUEST,
			requestId,
			clientId: this.clientId,
			request: { ...request, requestId },
			...(epoch !== undefined ? { epoch } : {}),
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
				resolve: (response, answeredBy) =>
					settle(() => {
						if (response.type === 'error' && response.code === LEADER_CHANGED) {
							reject(
								new BridgeTerminatedError(
									request.type,
									'storage leader changed during transaction',
								),
							)
							return
						}
						if (response.type === 'error' && response.code === BRIDGE_TERMINATED) {
							// The leader's worker stopped serving (its state became unknown);
							// the request did not run there.
							reject(new BridgeTerminatedError(request.type, response.message))
							return
						}
						if (request.type === 'begin' && response.type === 'success') {
							this.spanEpoch = answeredBy ?? LEGACY_RELAY_EPOCH
						} else if (request.type === 'commit' && response.type === 'success') {
							// A failed COMMIT keeps the binding for the ROLLBACK that follows.
							this.spanEpoch = undefined
						}
						resolve(response)
					}),
				reject: (error) => settle(() => reject(error)),
			})
			this.startWatchdog()
			this.channel.postMessage(msg)
		})
	}

	/**
	 * Ask the leader tab for one strict snapshot that holds every write committed before
	 * this call (one RPC, instead of exporting the whole database over the channel). The
	 * leader answers after its persistence scheduler saved a snapshot taken after the
	 * request arrived, sharing it with every other barrier waiting there.
	 *
	 * Resolves with the leader's answer (`error` when its snapshot failed: the caller treats
	 * the writes as not durable). Rejects with {@link LeaderUnresponsiveError} or
	 * {@link NoLeaderError} when the leader goes silent first (killed, frozen, hung),
	 * {@link BridgeTerminatedError} when this tab was promoted or left meanwhile, and
	 * {@link WorkerTimeoutError} past the timeout. It never resolves without the leader's
	 * word, so a caller can fall back safely.
	 */
	requestSnapshotBarrier(options: WorkerSendOptions = {}): Promise<WorkerResponse> {
		if (this.terminated) {
			return Promise.reject(
				new BridgeTerminatedError('snapshot-barrier', 'follower bridge terminated'),
			)
		}
		const requestId = createClientId()
		const signal = options.signal
		if (signal?.aborted) {
			return Promise.reject(new RequestAbortedError('snapshot-barrier', requestId))
		}
		const timeoutMs = options.timeoutMs ?? this.timeoutMs
		return new Promise<WorkerResponse>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined
			const onAbort = (): void => {
				settle(() => reject(new RequestAbortedError('snapshot-barrier', requestId)))
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
					settle(() => reject(new WorkerTimeoutError('follower-rpc:snapshot-barrier', timeoutMs)))
				}, timeoutMs)
			}
			signal?.addEventListener('abort', onAbort, { once: true })
			this.pending.set(requestId, {
				type: 'snapshot-barrier',
				...(this.lastRelayEpoch !== undefined ? { relayEpoch: this.lastRelayEpoch } : {}),
				resolve: (response) => settle(() => resolve(response)),
				reject: (error) => settle(() => reject(error)),
			})
			this.startWatchdog()
			const message: SnapshotBarrierRequestMessage = { type: SNAPSHOT_BARRIER_REQUEST, requestId }
			this.channel.postMessage(message)
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
		if (!this.heardSinceWatch) {
			this.lastHeardAt = now
			// Ask for a sign of life at once. Waiting a full interval first let a tick
			// that fired a millisecond "early" (interval timers and Date.now are not
			// aligned) skip its ping, so the next tick declared a live leader absent
			// without ever having asked it (LMS-7).
			this.channel.postMessage({ type: LEADER_PING })
		}
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
		// Pull a sign of life from leaders that do not push heartbeats: on every tick
		// that heard nothing for at least half an interval, so timer jitter can never
		// skip the probe before the limit above is reached.
		if (silentMs * 2 >= this.heartbeatMs) {
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

/** Options for {@link TransactionSerializingWorkerBridge}. */
export interface TransactionSerializingOptions {
	/**
	 * Called once when the serializer stops serving because the worker's
	 * transaction state is unknown (a ROLLBACK of a span, its own or the owner's,
	 * failed with anything but "no transaction is active").
	 * The owner must replace the worker; this one never runs another request.
	 */
	onBroken?: (reason: string) => void
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
	/** Set when the worker's transaction state became unknown; see {@link markBroken}. */
	private brokenReason: string | null = null
	private readonly onBroken: ((reason: string) => void) | undefined

	constructor(
		inner: WorkerBridge,
		transactionIdleTimeoutMs = DEFAULT_TRANSACTION_IDLE_TIMEOUT_MS,
		options: TransactionSerializingOptions = {},
	) {
		this.inner = inner
		this.transactionIdleTimeoutMs = transactionIdleTimeoutMs
		this.onBroken = options.onBroken
	}

	send(request: WorkerRequest, clientId = this.leaderClientId): Promise<WorkerResponse> {
		if (this.brokenReason !== null) {
			return Promise.reject(new BridgeTerminatedError(request.type, this.brokenReason))
		}
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
			} else if (request.type === 'rollback') {
				// The owner acknowledging the abort. The queue already rolled the span
				// back; running this ROLLBACK now could end another client's span.
				this.abortedClients.delete(clientId)
				return Promise.resolve({ id: request.id, type: 'success' })
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
			while (!this.terminated && !this.reclaiming) {
				const index = this.nextRunnableIndex()
				if (index === -1) {
					return
				}
				const [entry] = this.queue.splice(index, 1)
				if (!entry) {
					return
				}
				const inSpan = this.activeTransactionClient === entry.clientId
				// The owner is not idle while its own request runs.
				if (inSpan) this.clearTransactionIdleTimer()
				try {
					const response = await this.inner.send(entry.request)
					this.recordTransactionState(entry, response)
					entry.resolve(response)
				} catch (error) {
					// The worker's state is unknown (its BEGIN or a statement of the span may
					// have run). Roll the span back here, before any other client's request
					// runs, and refuse the owner's further span requests.
					if (inSpan || entry.request.type === 'begin') {
						await this.abortSpan(entry.clientId, 'request-failed')
					}
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

	/**
	 * Tracks which client owns the open SQLite transaction. The span stays held
	 * until its owner's COMMIT succeeds or its ROLLBACK is answered: an error on a
	 * statement inside the span (or on COMMIT, e.g. a deferred constraint) leaves
	 * SQLite's transaction open, so releasing the span then would let another
	 * client's request run inside it, be acknowledged, and be erased by the
	 * owner's rollback. A silent owner is reclaimed (rolled back) by the idle timer.
	 */
	private recordTransactionState(entry: QueuedWorkerRequest, response: WorkerResponse): void {
		const owner = this.activeTransactionClient === entry.clientId
		if (entry.request.type === 'begin' && !owner) {
			if (response.type === 'success') {
				this.activeTransactionClient = entry.clientId
				this.armTransactionIdleTimer(entry.clientId)
			}
			return
		}
		if (!owner) {
			return
		}
		if (entry.request.type === 'rollback') {
			const failure = unconfirmedRollback(response)
			if (failure !== null) {
				// The owner's ROLLBACK failed for another reason (e.g. disk I/O error):
				// SQLite may still hold the transaction open, so serving another client
				// could run its request inside it. Same rule as the queue's own rollback.
				this.markBroken(`owner rollback failed: ${failure}`)
				return
			}
			// Confirmed, or "no transaction is active" (SQLite already rolled it back):
			// the span is over.
			this.activeTransactionClient = null
			this.clearTransactionIdleTimer()
			return
		}
		if (entry.request.type === 'commit' && response.type === 'success') {
			this.activeTransactionClient = null
			this.clearTransactionIdleTimer()
			return
		}
		this.armTransactionIdleTimer(entry.clientId)
	}

	/**
	 * Rolls back `clientId`'s span from the queue itself and refuses the client's
	 * further span requests, before any other client's request runs.
	 */
	private async abortSpan(clientId: string, reason: string): Promise<void> {
		this.clearTransactionIdleTimer()
		if (this.activeTransactionClient === clientId) {
			this.activeTransactionClient = null
		}
		this.abortedClients.add(clientId)
		this.rejectQueuedClientRequests(clientId, reason)
		await this.rollbackOrBreak(reason)
	}

	/**
	 * The queue's own ROLLBACK of a span it took back. If it fails (throws, or
	 * answers with anything but "no transaction is active"), the transaction may
	 * still be open in the worker: serving another client then would run its
	 * request inside that transaction, acknowledge it, and lose it with the
	 * eventual rollback. So the serializer stops serving instead.
	 */
	private async rollbackOrBreak(reason: string): Promise<void> {
		let failure: string | null = null
		try {
			const response = await this.inner.send({ id: 0, type: 'rollback' })
			failure = unconfirmedRollback(response)
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error)
		}
		if (failure !== null) {
			this.markBroken(`rollback after ${reason} failed: ${failure}`)
		}
	}

	/**
	 * Stops serving for good: queued requests fail with a retriable
	 * {@link BridgeTerminatedError} without running, later sends fail the same way,
	 * the inner bridge is terminated, and `onBroken` lets the owner replace the
	 * worker (terminating a worker discards its uncommitted transaction).
	 */
	private markBroken(reason: string): void {
		if (this.brokenReason !== null || this.terminated) return
		this.brokenReason = `storage worker state unknown (${reason})`
		this.clearTransactionIdleTimer()
		this.activeTransactionClient = null
		for (const entry of this.queue.splice(0)) {
			entry.reject(new BridgeTerminatedError(entry.request.type, this.brokenReason))
		}
		this.terminated = true
		this.inner.terminate()
		try {
			this.onBroken?.(this.brokenReason)
		} catch (error) {
			console.error('[kora] onBroken handler failed:', error)
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
			await this.rollbackOrBreak(reason)
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

/**
 * Why a ROLLBACK response does not confirm that no transaction is open, or null
 * when it does: success, or "no transaction is active" (SQLite had already
 * rolled the transaction back, e.g. after SQLITE_FULL or an interrupt).
 */
function unconfirmedRollback(response: WorkerResponse): string | null {
	if (response.type !== 'error') return null
	return /no transaction is active/i.test(response.message) ? null : response.message
}

function errorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null)?.code
	return typeof code === 'string' ? code : undefined
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
