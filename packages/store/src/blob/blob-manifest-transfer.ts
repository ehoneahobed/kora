import { type BlobRef, type BlobRefMetadata, hashBlob } from '@korajs/core'
import { type BlobManifest, chunkBlob } from './blob-chunking'
import type { ChunkProvider } from './blob-transfer'
import { BlobIntegrityError, type ContentAddressedBlobStore } from './content-addressed-blob-store'

/**
 * Serialize a {@link BlobManifest} to canonical bytes for content addressing.
 *
 * Fields are emitted in a fixed order so the same manifest always produces the
 * same bytes, which is what lets the manifest be stored and fetched under its own
 * SHA-256 hash. Optional fields are omitted when absent.
 */
export function serializeBlobManifest(manifest: BlobManifest): Uint8Array {
	const canonical: Record<string, unknown> = {
		blobHash: manifest.blobHash,
		size: manifest.size,
		chunkSize: manifest.chunkSize,
		chunkHashes: manifest.chunkHashes,
	}
	if (manifest.mimeType !== undefined) {
		canonical.mimeType = manifest.mimeType
	}
	if (manifest.filename !== undefined) {
		canonical.filename = manifest.filename
	}
	return new TextEncoder().encode(JSON.stringify(canonical))
}

/**
 * Parse canonical manifest bytes back into a {@link BlobManifest}, validating the
 * shape. Throws on malformed input rather than returning a partial manifest.
 */
export function parseBlobManifest(bytes: Uint8Array): BlobManifest {
	const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
	if (typeof parsed !== 'object' || parsed === null) {
		throw new Error('Invalid blob manifest: not an object')
	}
	const obj = parsed as Record<string, unknown>
	if (typeof obj.blobHash !== 'string') {
		throw new Error('Invalid blob manifest: missing blobHash')
	}
	if (typeof obj.size !== 'number' || typeof obj.chunkSize !== 'number') {
		throw new Error('Invalid blob manifest: missing size or chunkSize')
	}
	if (!Array.isArray(obj.chunkHashes) || obj.chunkHashes.some((h) => typeof h !== 'string')) {
		throw new Error('Invalid blob manifest: chunkHashes must be an array of strings')
	}
	const manifest: BlobManifest = {
		blobHash: obj.blobHash,
		size: obj.size,
		chunkSize: obj.chunkSize,
		chunkHashes: obj.chunkHashes as string[],
	}
	if (typeof obj.mimeType === 'string') {
		manifest.mimeType = obj.mimeType
	}
	if (typeof obj.filename === 'string') {
		manifest.filename = obj.filename
	}
	return manifest
}

/**
 * Store a blob for out-of-band transfer, addressed entirely by content.
 *
 * Stages the blob's chunks (so this device can serve them), stores the full blob
 * (so local reads by hash are O(1)), and stores the blob's manifest as its own
 * content-addressed object. The returned {@link BlobRef} carries `manifestHash`,
 * so a peer that receives the reference in a synced record can pull the bytes
 * knowing only the reference — no separate manifest hand-off.
 *
 * @param store - The content-addressed store to stage chunks, blob, and manifest in
 * @param bytes - The full blob content
 * @param options - Optional chunk size and metadata
 * @returns The reference (including `manifestHash`) and the manifest
 */
export async function putBlobForTransfer(
	store: ContentAddressedBlobStore,
	bytes: Uint8Array,
	options: { chunkSize?: number } & BlobRefMetadata = {},
): Promise<{ ref: BlobRef; manifest: BlobManifest }> {
	const { manifest, chunks } = await chunkBlob(bytes, options.chunkSize, {
		...(options.mimeType !== undefined ? { mimeType: options.mimeType } : {}),
		...(options.filename !== undefined ? { filename: options.filename } : {}),
	})
	for (const chunk of chunks.values()) {
		await store.put(chunk)
	}
	// Full blob for local O(1) reads by content hash.
	const baseRef = await store.put(bytes, {
		...(options.mimeType !== undefined ? { mimeType: options.mimeType } : {}),
		...(options.filename !== undefined ? { filename: options.filename } : {}),
	})
	// Manifest as its own content-addressed object, served over the same channel.
	const manifestRef = await store.put(serializeBlobManifest(manifest))
	return { ref: { ...baseRef, manifestHash: manifestRef.hash }, manifest }
}

/**
 * Fetch and integrity-verify a blob's manifest from a {@link ChunkProvider}.
 *
 * The manifest is a content-addressed object like a chunk, so it is requested by
 * its hash, verified to hash to that value, and parsed. Used to resolve a
 * {@link BlobRef}'s manifest before pulling the blob's chunks.
 *
 * @param provider - The source to fetch the manifest bytes from
 * @param manifestHash - The manifest's content hash (from `BlobRef.manifestHash`)
 * @throws {BlobIntegrityError} If the fetched bytes do not hash to `manifestHash`
 * @throws {Error} If the provider cannot supply the manifest
 */
export async function fetchBlobManifest(
	provider: ChunkProvider,
	manifestHash: string,
): Promise<BlobManifest> {
	const bytes = await provider.getChunk(manifestHash)
	if (bytes === null) {
		throw new Error(`Blob manifest ${manifestHash} could not be fetched from the provider`)
	}
	const actual = await hashBlob(bytes)
	if (actual !== manifestHash) {
		throw new BlobIntegrityError(manifestHash, actual)
	}
	return parseBlobManifest(bytes)
}

/**
 * Resolve the manifest for a {@link BlobRef} that was stored via
 * {@link putBlobForTransfer}. Fetches and verifies the manifest by the ref's
 * `manifestHash`.
 *
 * @throws {Error} If the ref has no `manifestHash` (it was not stored for transfer)
 */
export async function resolveBlobManifest(
	provider: ChunkProvider,
	ref: BlobRef,
): Promise<BlobManifest> {
	if (ref.manifestHash === undefined) {
		throw new Error(
			`Blob ${ref.hash} has no manifest to resolve. Store it with putBlobForTransfer (or app.blobs.put) so its reference carries a manifestHash, or pull with an explicit manifest.`,
		)
	}
	return fetchBlobManifest(provider, ref.manifestHash)
}
