/**
 * Multi-tab SQLite storage coordination via `navigator.locks` and `BroadcastChannel`.
 *
 * One tab holds the exclusive `kora-leader-${dbName}` lock and owns the SQLite worker.
 * Other tabs send worker RPC over a named broadcast channel.
 */

import type { WorkerBridge, WorkerRequest, WorkerResponse } from '../adapters/sqlite-wasm-channel'
import { WorkerTimeoutError } from '../errors'

const RPC_REQUEST = 'kora-worker-request'
const RPC_RESPONSE = 'kora-worker-response'

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

export interface TabStorageSession {
	role: TabStorageRole
	channelName: string
	/** Leader only: release the navigator lock when closing the database. */
	releaseLock?: () => Promise<void>
	/** Leader only: stop the broadcast RPC relay. */
	stopRelay?: () => void
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
 */
export async function acquireTabStorageSession(dbName: string): Promise<TabStorageSession> {
	const channelName = `kora-storage-${dbName}`

	if (!isMultiTabStorageSupported()) {
		return { role: 'leader', channelName }
	}

	return new Promise<TabStorageSession>((resolve) => {
		let releaseHeld: (() => void) | undefined

		void navigator.locks.request(
			`kora-leader-${dbName}`,
			{ mode: 'exclusive', ifAvailable: true },
			(lock) => {
				if (lock === null) {
					resolve({ role: 'follower', channelName })
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
			},
		)
	})
}

/**
 * Leader tab: forward follower RPC to the real worker bridge.
 */
export function startLeaderRpcRelay(channelName: string, bridge: WorkerBridge): () => void {
	const channel = new BroadcastChannel(channelName)

	const onMessage = (event: MessageEvent<RpcRequestMessage>): void => {
		const data = event.data
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
	private terminated = false

	constructor(channelName: string, timeoutMs = 30000) {
		this.timeoutMs = timeoutMs
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
			const timer = setTimeout(() => {
				this.pending.delete(requestId)
				reject(new WorkerTimeoutError(`follower-rpc:${request.type}`, this.timeoutMs))
			}, this.timeoutMs)

			this.pending.set(requestId, {
				resolve: (response) => {
					clearTimeout(timer)
					resolve(response)
				},
				reject: (error) => {
					clearTimeout(timer)
					reject(error)
				},
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
