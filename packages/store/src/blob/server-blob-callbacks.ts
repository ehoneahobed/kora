import { hashBlob } from '@korajs/core'
import { type ContentAddressedBlobStore, MemoryBlobStore } from './content-addressed-blob-store'

/**
 * The server-side blob callbacks a `KoraSyncServer` accepts: read a chunk by
 * hash (to serve it) and persist an uploaded chunk by hash (to store it).
 */
export interface ServerBlobCallbacks {
	resolveBlobChunk: (hash: string) => Promise<Uint8Array | null>
	persistBlobChunk: (hash: string, bytes: Uint8Array) => Promise<void>
}

/**
 * Adapt a {@link ContentAddressedBlobStore} into the read/persist callbacks a
 * `KoraSyncServer` needs for central blob storage. The server package depends
 * only on these plain function signatures, so a self-hosted server can back its
 * blob storage with any store (for example a `FilesystemBlobStore`) without the
 * server package taking a dependency on `@korajs/store`.
 *
 * @example
 * ```typescript
 * const server = new KoraSyncServer({
 *   store,
 *   ...toServerBlobCallbacks(new FilesystemBlobStore('/var/kora/blobs')),
 * })
 * ```
 */
export function toServerBlobCallbacks(store: ContentAddressedBlobStore): ServerBlobCallbacks {
	return {
		resolveBlobChunk: (hash) => store.get(hash),
		async persistBlobChunk(hash, bytes) {
			// The store keys by the hash it computes from the bytes; verify it matches
			// the declared hash so a mismatched upload is rejected, not silently stored
			// under the wrong key.
			const actual = await hashBlob(bytes)
			if (actual !== hash) {
				return
			}
			await store.put(bytes)
		},
	}
}

/**
 * Convenience: an in-memory central blob store plus its server callbacks. For
 * tests and single-process deployments. Persistent deployments should back
 * {@link toServerBlobCallbacks} with a durable store instead.
 */
export function createMemoryServerBlobStore(): {
	store: MemoryBlobStore
	callbacks: ServerBlobCallbacks
} {
	const store = new MemoryBlobStore()
	return { store, callbacks: toServerBlobCallbacks(store) }
}
