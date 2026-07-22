import { type BlobRef, hashBlob } from '@korajs/core'
import { type BlobManifest, chunkBlob, reassembleBlob } from './blob-chunking'
import { BlobIntegrityError, type ContentAddressedBlobStore } from './content-addressed-blob-store'

/**
 * A source of chunk bytes on the sending side of a transfer. In production this
 * is backed by the sync connection (the receiver requests a chunk hash, the peer
 * that holds the blob answers with the bytes); in tests it is backed by a map.
 */
export interface ChunkProvider {
	/** Fetch the bytes for a chunk hash, or null if the provider does not have it. */
	getChunk(hash: string): Promise<Uint8Array | null>
}

/** Result of receiving a blob out of band. */
export interface ReceiveBlobResult {
	/** The content-addressed reference to the reassembled blob. */
	ref: BlobRef
	/** Number of chunks actually fetched from the provider. */
	chunksFetched: number
	/** Number of chunks skipped because they were already held locally. */
	chunksSkipped: number
}

/** Stores used while receiving a blob. */
export interface ReceiveBlobStores {
	/**
	 * Where fetched chunks are staged, keyed by chunk hash. A persistent chunk
	 * store makes a transfer resumable: an interrupted transfer leaves its chunks
	 * here, and a resumed transfer skips them.
	 */
	chunkStore: ContentAddressedBlobStore
	/** Where the fully reassembled, verified blob is written. */
	blobStore: ContentAddressedBlobStore
}

/**
 * Receive a blob out of band, chunk by chunk, resumably and with integrity
 * verification at every step.
 *
 * For each chunk named in the manifest: if the chunk store already holds it (a
 * prior, possibly interrupted transfer), it is skipped; otherwise it is fetched
 * from the provider and verified to hash to the expected chunk hash before being
 * staged. Once every chunk is present, the blob is reassembled, verified against
 * the manifest's blob hash, and written to the blob store (which deduplicates).
 *
 * The transfer is idempotent: running it again after completion fetches nothing
 * and returns the same reference.
 *
 * @param manifest - The manifest of the blob to receive
 * @param provider - The source of chunk bytes
 * @param stores - The chunk staging store and the destination blob store
 * @returns The reference plus how many chunks were fetched versus skipped
 * @throws {BlobIntegrityError} If a fetched chunk or the whole blob fails verification
 * @throws {Error} If the provider cannot supply a required chunk
 */
export async function receiveBlob(
	manifest: BlobManifest,
	provider: ChunkProvider,
	stores: ReceiveBlobStores,
): Promise<ReceiveBlobResult> {
	let chunksFetched = 0
	let chunksSkipped = 0

	// Distinct chunk hashes only: a manifest may repeat a hash, but we need each
	// unique chunk exactly once. Skipping duplicates also means a blob made of
	// identical chunks transfers that chunk a single time.
	const seen = new Set<string>()
	for (const hash of manifest.chunkHashes) {
		if (seen.has(hash)) {
			continue
		}
		seen.add(hash)

		if (await stores.chunkStore.has(hash)) {
			chunksSkipped++
			continue
		}

		const bytes = await provider.getChunk(hash)
		if (bytes === null) {
			throw new Error(`Blob transfer failed: provider could not supply chunk ${hash}`)
		}
		const actual = await hashBlob(bytes)
		if (actual !== hash) {
			throw new BlobIntegrityError(hash, actual)
		}
		await stores.chunkStore.put(bytes)
		chunksFetched++
	}

	const full = await reassembleBlob(manifest, stores.chunkStore)
	const ref = await stores.blobStore.put(full, {
		mimeType: manifest.mimeType,
		filename: manifest.filename,
	})

	return { ref, chunksFetched, chunksSkipped }
}

/**
 * Prepare a blob for out-of-band sending: split it into chunks, stage those
 * chunks in a content-addressed store, and return the manifest plus a
 * {@link ChunkProvider} that serves the chunks from that store.
 *
 * @param bytes - The full blob content
 * @param chunkStore - Where to stage the chunks (served to receivers)
 * @param options - Optional chunk size and metadata
 * @returns The manifest and a provider that serves the staged chunks
 */
export async function prepareBlobForSend(
	bytes: Uint8Array,
	chunkStore: ContentAddressedBlobStore,
	options: { chunkSize?: number; mimeType?: string; filename?: string } = {},
): Promise<{ manifest: BlobManifest; provider: ChunkProvider }> {
	const { manifest, chunks } = await chunkBlob(bytes, options.chunkSize, {
		mimeType: options.mimeType,
		filename: options.filename,
	})
	for (const chunk of chunks.values()) {
		await chunkStore.put(chunk)
	}
	const provider: ChunkProvider = {
		getChunk: (hash) => chunkStore.get(hash),
	}
	return { manifest, provider }
}
