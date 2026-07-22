import { hashBlob } from '@korajs/core'
import { BlobIntegrityError, type ContentAddressedBlobStore } from './content-addressed-blob-store'

/** Default chunk size for out-of-band blob transfer (256 KiB). */
export const DEFAULT_CHUNK_SIZE = 256 * 1024

/**
 * A manifest describing how a blob is split into content-addressed chunks.
 *
 * The manifest is small and travels with the operation stream (or alongside it);
 * the chunk bytes travel out of band. Because every chunk is content-addressed,
 * identical chunks across blobs are stored and transferred once, and a peer only
 * ever requests chunk hashes it does not already hold.
 */
export interface BlobManifest {
	/** Hex SHA-256 hash of the full reassembled blob (its content address). */
	blobHash: string
	/** Total size of the full blob in bytes. */
	size: number
	/** The chunk size used to split the blob. */
	chunkSize: number
	/** Ordered hashes of each chunk. Repeats when identical chunks recur. */
	chunkHashes: string[]
	mimeType?: string
	filename?: string
}

/** Optional metadata carried on a manifest. */
export interface BlobManifestMetadata {
	mimeType?: string
	filename?: string
}

/**
 * Split a blob into content-addressed chunks and produce its manifest.
 *
 * @param bytes - The full blob content
 * @param chunkSize - Bytes per chunk (defaults to {@link DEFAULT_CHUNK_SIZE})
 * @param metadata - Optional mime type / filename to record on the manifest
 * @returns The manifest and a map of chunk hash to chunk bytes (deduplicated)
 */
export async function chunkBlob(
	bytes: Uint8Array,
	chunkSize: number = DEFAULT_CHUNK_SIZE,
	metadata: BlobManifestMetadata = {},
): Promise<{ manifest: BlobManifest; chunks: Map<string, Uint8Array> }> {
	if (chunkSize <= 0) {
		throw new Error(`chunkBlob requires a positive chunkSize, got ${chunkSize}`)
	}

	const chunkHashes: string[] = []
	const chunks = new Map<string, Uint8Array>()

	for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
		const end = Math.min(offset + chunkSize, bytes.byteLength)
		const chunk = new Uint8Array(end - offset)
		chunk.set(bytes.subarray(offset, end))
		const hash = await hashBlob(chunk)
		chunkHashes.push(hash)
		// Identical chunks collapse to one stored entry; the ordered hash list
		// still records every position so reassembly reproduces the exact bytes.
		if (!chunks.has(hash)) {
			chunks.set(hash, chunk)
		}
	}

	const blobHash = await hashBlob(bytes)
	const manifest: BlobManifest = {
		blobHash,
		size: bytes.byteLength,
		chunkSize,
		chunkHashes,
	}
	if (metadata.mimeType !== undefined) {
		manifest.mimeType = metadata.mimeType
	}
	if (metadata.filename !== undefined) {
		manifest.filename = metadata.filename
	}

	return { manifest, chunks }
}

/**
 * Reassemble a blob from chunks held in a content-addressed store, verifying
 * integrity at both levels: each chunk is verified by the store on read, and the
 * reassembled whole is verified against the manifest's blob hash.
 *
 * @param manifest - The blob manifest
 * @param chunkStore - A store holding the chunk bytes keyed by chunk hash
 * @returns The full reassembled blob bytes
 * @throws {BlobIntegrityError} If the reassembled bytes do not match blobHash
 * @throws {Error} If a chunk named in the manifest is missing from the store
 */
export async function reassembleBlob(
	manifest: BlobManifest,
	chunkStore: ContentAddressedBlobStore,
): Promise<Uint8Array> {
	const parts: Uint8Array[] = []
	let total = 0

	for (const hash of manifest.chunkHashes) {
		const chunk = await chunkStore.get(hash)
		if (chunk === null) {
			throw new Error(`Cannot reassemble blob ${manifest.blobHash}: missing chunk ${hash}`)
		}
		parts.push(chunk)
		total += chunk.byteLength
	}

	const out = new Uint8Array(total)
	let offset = 0
	for (const part of parts) {
		out.set(part, offset)
		offset += part.byteLength
	}

	const actual = await hashBlob(out)
	if (actual !== manifest.blobHash) {
		throw new BlobIntegrityError(manifest.blobHash, actual)
	}
	return out
}
