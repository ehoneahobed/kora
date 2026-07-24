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
const LEADER_PING = 'kora-leader-ping'
const LEADER_PONG = 'kora-leader-pong'

/** Default delay before a stalled follower RPC probes the leader for liveness. */
const DEFAULT_LIVENESS_PROBE_MS = 2000

interface RpcRequestMessage {
	type: typeof RPC_REQUEST
	requestId: string
	request: WorkerRequest
}

interface RpcResponseMessage {
	type: typeof RPC_RESPONSE
	requestId: string
	response: WorkerResponse
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
 * Returns whether a SharedWorker could host a single SQLite WASM instance per origin.
 * Not implemented yet — use {@link isMultiTabStorageSupported} + leader election today.
 */
export function isSharedWorkerStorageSupported(): boolean {
	return typeof globalThis !== 'undefined' && typeof SharedWorker !== 'undefined'
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
		event: MessageEvent<RpcRequestMessage | { type: typeof LEADER_PING }>,
	): void => {
		const data = event.data
		// Answer liveness probes immediately, without touching the worker, so a
		// follower can distinguish a slow-but-alive leader from an absent one.
		if (data?.type === LEADER_PING) {
			channel.postMessage({ type: LEADER_PONG })
			return
		}
		if (data?.type !== RPC_REQUEST) {
			return
		}

		void bridge
			.send(data.request)
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

		const requestId = crypto.randomUUID()
		const msg: RpcRequestMessage = { type: RPC_REQUEST, requestId, request }

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
		this.channel.close()
		for (const [, entry] of this.pending) {
			entry.reject(new Error('Follower bridge terminated'))
		}
		this.pending.clear()
	}
}
