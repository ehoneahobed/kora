import { generateUUIDv7 } from '@korajs/core'
import type { ChunkProvider } from './blob-transfer'
import type { ContentAddressedBlobStore } from './content-addressed-blob-store'

/**
 * Blob chunk exchange messages. These ride any message transport (the sync
 * WebSocket in production, an in-memory pair in tests). A receiver requests a
 * chunk by hash and correlates the answer by `requestId`.
 */
export interface ChunkRequestMessage {
	type: 'blob-chunk-request'
	requestId: string
	hash: string
}
export interface ChunkResponseMessage {
	type: 'blob-chunk-response'
	requestId: string
	/** The chunk bytes, or null when the responder does not hold that hash. */
	bytes: Uint8Array | null
	/**
	 * The server refused the request for rate, not because the chunk is missing
	 * (RT-24). The requester retries after `retryAfterMs` instead of failing.
	 */
	throttled?: boolean
	/** With `throttled`: how long to wait before retrying, in ms. */
	retryAfterMs?: number
}
export type ChunkMessage = ChunkRequestMessage | ChunkResponseMessage

/**
 * A bidirectional message port carrying {@link ChunkMessage}s. Implemented over
 * the sync connection in production; `createChunkPortPair` provides an in-memory
 * duplex pair for tests.
 */
export interface ChunkMessagePort {
	send(message: ChunkMessage): void
	/** Register a handler for incoming messages. Multiple handlers are allowed. */
	onMessage(handler: (message: ChunkMessage) => void): void
}

/** A {@link ChunkProvider} that fetches chunks over a message port. */
export interface RemoteChunkProvider extends ChunkProvider {
	/** Number of requests still awaiting a response (for diagnostics/tests). */
	pendingCount(): number
}

/** Options for {@link createRemoteChunkProvider}. */
export interface RemoteChunkProviderOptions {
	/** Per-attempt timeout in ms (default 30s). */
	timeoutMs?: number
	/**
	 * Longest total time one chunk may spend waiting on "throttled" answers before
	 * the request fails (default 10 minutes). The transfer is resumable, so a failed
	 * request can simply be retried later.
	 */
	maxThrottleWaitMs?: number
	/** Smallest back-off after a throttled answer, in ms (default 250). */
	minThrottleDelayMs?: number
	/** Largest single back-off after a throttled answer, in ms (default 30s). */
	maxThrottleDelayMs?: number
}

/**
 * Create a {@link ChunkProvider} that requests chunks over a message port,
 * correlating each answer to its request and timing out a stalled request so a
 * dropped response cannot hang a transfer forever (the transfer is resumable, so
 * a timed-out request can simply be retried).
 *
 * A "throttled" answer (the server's blob request budget is spent, RT-24) is not a
 * failure: the request is re-sent after the server's `retryAfterMs` (bounded, with
 * exponential back-off when absent), until `maxThrottleWaitMs` has elapsed.
 *
 * @param port - The message port to the peer that holds the blob
 * @param options - Timeouts and throttle back-off bounds
 */
export function createRemoteChunkProvider(
	port: ChunkMessagePort,
	options: RemoteChunkProviderOptions = {},
): RemoteChunkProvider {
	const timeoutMs = options.timeoutMs ?? 30_000
	const maxThrottleWaitMs = options.maxThrottleWaitMs ?? 10 * 60_000
	const minDelayMs = options.minThrottleDelayMs ?? 250
	const maxDelayMs = options.maxThrottleDelayMs ?? 30_000
	const pending = new Map<
		string,
		{
			hash: string
			resolve: (bytes: Uint8Array | null) => void
			reject: (error: Error) => void
			timer: ReturnType<typeof setTimeout>
			startedAtMs: number
			throttledCount: number
		}
	>()

	const armTimeout = (requestId: string, hash: string): ReturnType<typeof setTimeout> =>
		setTimeout(() => {
			const entry = pending.get(requestId)
			if (!entry) return
			pending.delete(requestId)
			entry.reject(new Error(`Blob chunk request for ${hash} timed out after ${timeoutMs}ms`))
		}, timeoutMs)

	port.onMessage((message) => {
		if (message.type !== 'blob-chunk-response') {
			return
		}
		const entry = pending.get(message.requestId)
		if (!entry) {
			return
		}
		clearTimeout(entry.timer)
		if (message.throttled === true) {
			// Over the server's blob budget: back off and ask again, same request id.
			entry.throttledCount += 1
			const backoff = Math.min(maxDelayMs, minDelayMs * 2 ** (entry.throttledCount - 1))
			const delay = Math.min(maxDelayMs, Math.max(minDelayMs, message.retryAfterMs ?? backoff))
			if (Date.now() + delay - entry.startedAtMs > maxThrottleWaitMs) {
				pending.delete(message.requestId)
				entry.reject(
					new Error(
						`Blob chunk request for ${entry.hash} was throttled for longer than ${maxThrottleWaitMs}ms`,
					),
				)
				return
			}
			entry.timer = setTimeout(() => {
				if (pending.get(message.requestId) !== entry) return
				entry.timer = armTimeout(message.requestId, entry.hash)
				port.send({ type: 'blob-chunk-request', requestId: message.requestId, hash: entry.hash })
			}, delay)
			return
		}
		pending.delete(message.requestId)
		entry.resolve(message.bytes)
	})

	return {
		pendingCount: () => pending.size,
		getChunk(hash: string): Promise<Uint8Array | null> {
			const requestId = generateUUIDv7()
			return new Promise<Uint8Array | null>((resolve, reject) => {
				pending.set(requestId, {
					hash,
					resolve,
					reject,
					timer: armTimeout(requestId, hash),
					startedAtMs: Date.now(),
					throttledCount: 0,
				})
				port.send({ type: 'blob-chunk-request', requestId, hash })
			})
		},
	}
}

/**
 * Serve blob chunk requests arriving on a message port from a blob store. Answers
 * each `blob-chunk-request` with the bytes for that hash, or null when the store
 * does not hold it. Returns nothing; attach it once per connection.
 *
 * @param port - The message port from the peer requesting chunks
 * @param blobStore - The store to serve chunks from (keyed by chunk hash)
 */
export function serveBlobChunks(
	port: ChunkMessagePort,
	blobStore: ContentAddressedBlobStore,
): void {
	port.onMessage((message) => {
		if (message.type !== 'blob-chunk-request') {
			return
		}
		void blobStore.get(message.hash).then(
			(bytes) => {
				port.send({ type: 'blob-chunk-response', requestId: message.requestId, bytes })
			},
			() => {
				// Integrity failure or read error: report as not-held rather than
				// crashing the connection. The requester treats null as unavailable.
				port.send({ type: 'blob-chunk-response', requestId: message.requestId, bytes: null })
			},
		)
	})
}

/**
 * Create a connected in-memory pair of {@link ChunkMessagePort}s. Messages sent
 * on one arrive on the other, asynchronously (next microtask) so the pair models
 * a real transport rather than re-entrant synchronous delivery. For tests.
 */
export function createChunkPortPair(): { a: ChunkMessagePort; b: ChunkMessagePort } {
	const handlersA: Array<(m: ChunkMessage) => void> = []
	const handlersB: Array<(m: ChunkMessage) => void> = []

	const a: ChunkMessagePort = {
		send(message) {
			queueMicrotask(() => {
				for (const handler of handlersB) {
					handler(message)
				}
			})
		},
		onMessage(handler) {
			handlersA.push(handler)
		},
	}
	const b: ChunkMessagePort = {
		send(message) {
			queueMicrotask(() => {
				for (const handler of handlersA) {
					handler(message)
				}
			})
		},
		onMessage(handler) {
			handlersB.push(handler)
		},
	}
	return { a, b }
}
