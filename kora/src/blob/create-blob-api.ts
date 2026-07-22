import type { BlobRef, BlobRefMetadata } from '@korajs/core'
import {
	type BlobGcOptions,
	type BlobGcResult,
	type BlobManifest,
	type ChunkProvider,
	type ContentAddressedBlobStore,
	type ReceiveBlobResult,
	collectBlobGarbage,
	putBlobForTransfer,
	receiveBlob,
	resolveBlobManifest,
} from '@korajs/store'
import type { BlobApi } from '../types'

/** Whether a pull source is already a manifest (versus a reference to resolve). */
function isManifest(source: BlobRef | BlobManifest): source is BlobManifest {
	return 'chunkHashes' in source
}

/**
 * Build the `app.blobs` facade over a content-addressed blob store and, when
 * sync is active, a chunk provider bound to the live connection.
 *
 * `put` stages a blob's chunks (so this device can serve them), stores the blob
 * for local reads, and stores the blob's manifest as its own content-addressed
 * object — so the returned reference carries a `manifestHash` and a peer can pull
 * the bytes knowing only the reference it received in a synced record. `pull`
 * accepts that reference (or an explicit manifest) and fetches the bytes over the
 * sync connection. Without sync, local blob storage still works; `pull` reports
 * that no connection is available.
 *
 * @param blobStore - The content-addressed store holding blob bytes, chunks, and manifests
 * @param chunkProvider - Provider bound to the sync connection, or null when offline-only
 * @param defaultChunkSize - Chunk size used by `put`
 */
export function createBlobApi(
	blobStore: ContentAddressedBlobStore,
	chunkProvider: ChunkProvider | null,
	defaultChunkSize: number | undefined,
	enumerateLiveRefs: () => Promise<BlobRef[]>,
): BlobApi {
	function requireProvider(): ChunkProvider {
		if (!chunkProvider) {
			throw new Error(
				'Cannot pull blob bytes without an active sync connection. Configure sync on createApp and ensure the app is connected before calling app.blobs.pull().',
			)
		}
		return chunkProvider
	}

	return {
		store: blobStore,
		put(
			bytes: Uint8Array,
			metadata?: BlobRefMetadata,
		): Promise<{ ref: BlobRef; manifest: BlobManifest }> {
			return putBlobForTransfer(blobStore, bytes, {
				...(defaultChunkSize !== undefined ? { chunkSize: defaultChunkSize } : {}),
				...(metadata?.mimeType !== undefined ? { mimeType: metadata.mimeType } : {}),
				...(metadata?.filename !== undefined ? { filename: metadata.filename } : {}),
			})
		},
		get(hash: string): Promise<Uint8Array | null> {
			return blobStore.get(hash)
		},
		has(hash: string): Promise<boolean> {
			return blobStore.has(hash)
		},
		delete(hash: string): Promise<boolean> {
			return blobStore.delete(hash)
		},
		async pull(source: BlobRef | BlobManifest): Promise<ReceiveBlobResult> {
			const provider = requireProvider()
			// A bare reference resolves its manifest over the connection first (the
			// manifest is itself a content-addressed object); an explicit manifest is
			// used directly.
			const manifest = isManifest(source) ? source : await resolveBlobManifest(provider, source)
			return receiveBlob(manifest, provider, {
				chunkStore: blobStore,
				blobStore,
			})
		},
		async gc(options?: BlobGcOptions): Promise<BlobGcResult> {
			const liveRefs = await enumerateLiveRefs()
			return collectBlobGarbage(blobStore, liveRefs, options)
		},
	}
}
