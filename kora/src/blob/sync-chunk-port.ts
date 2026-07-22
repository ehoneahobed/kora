import type { ChunkMessage, ChunkMessagePort } from '@korajs/store'
import type { SyncEngine } from '@korajs/sync'

/**
 * Bind the store's transport-agnostic {@link ChunkMessagePort} to a live sync
 * connection. The returned port carries blob chunk requests and responses over
 * the same WebSocket the sync engine already owns, so blob bytes transfer out of
 * band from the operation stream without a second connection.
 *
 * Pair it with `@korajs/store`'s `createRemoteChunkProvider(port)` to pull a
 * blob's chunks from peers (or the server), and `serveBlobChunks(port, store)`
 * to answer requests for chunks this device holds. The sync engine's blob-chunk
 * channel handles the base64 wire encoding; this adapter only maps message
 * shapes, which are identical on both sides.
 *
 * @param syncEngine - The client's sync engine (from `app.getSyncEngine()`)
 * @returns A `ChunkMessagePort` over the sync connection
 *
 * @example
 * ```typescript
 * const port = createSyncEngineChunkPort(app.getSyncEngine())
 * const provider = createRemoteChunkProvider(port)
 * const result = await receiveBlob(manifest, provider, { chunkStore, blobStore })
 * ```
 */
export function createSyncEngineChunkPort(syncEngine: SyncEngine): ChunkMessagePort {
	const channel = syncEngine.getBlobChunkChannel()
	return {
		send(message: ChunkMessage): void {
			// ChunkMessage and the channel's decoded message shape are identical
			// (request: {requestId, hash}; response: {requestId, bytes}).
			channel.send(message)
		},
		onMessage(handler: (message: ChunkMessage) => void): void {
			channel.onMessage((decoded) => {
				// The store's ChunkMessagePort speaks only request/response. Uploads
				// (blob-chunk-push) are a separate server-ingest concern, not routed here.
				if (decoded.type === 'blob-chunk-request' || decoded.type === 'blob-chunk-response') {
					handler(decoded)
				}
			})
		},
	}
}
