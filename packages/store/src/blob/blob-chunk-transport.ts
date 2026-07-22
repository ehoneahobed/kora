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

/**
 * Create a {@link ChunkProvider} that requests chunks over a message port,
 * correlating each answer to its request and timing out a stalled request so a
 * dropped response cannot hang a transfer forever (the transfer is resumable, so
 * a timed-out request can simply be retried).
 *
 * @param port - The message port to the peer that holds the blob
 * @param options.timeoutMs - Per-request timeout (default 30s)
 */
export function createRemoteChunkProvider(
	port: ChunkMessagePort,
	options: { timeoutMs?: number } = {},
): RemoteChunkProvider {
	const timeoutMs = options.timeoutMs ?? 30_000
	const pending = new Map<
		string,
		{
			resolve: (bytes: Uint8Array | null) => void
			reject: (error: Error) => void
			timer: ReturnType<typeof setTimeout>
		}
	>()

	port.onMessage((message) => {
		if (message.type !== 'blob-chunk-response') {
			return
		}
		const entry = pending.get(message.requestId)
		if (!entry) {
			return
		}
		pending.delete(message.requestId)
		clearTimeout(entry.timer)
		entry.resolve(message.bytes)
	})

	return {
		pendingCount: () => pending.size,
		getChunk(hash: string): Promise<Uint8Array | null> {
			const requestId = generateUUIDv7()
			return new Promise<Uint8Array | null>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(requestId)
					reject(new Error(`Blob chunk request for ${hash} timed out after ${timeoutMs}ms`))
				}, timeoutMs)
				pending.set(requestId, { resolve, reject, timer })
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
