import type { BlobRef } from '../types'

/**
 * Compute the hex-encoded SHA-256 content hash of a byte buffer.
 *
 * This is the content address of a blob: identical bytes always hash to the same
 * value, which is what lets the blob store deduplicate content and lets a peer
 * skip transferring bytes it already holds.
 *
 * @param bytes - The binary content to hash
 * @returns The hex-encoded SHA-256 hash
 */
export async function hashBlob(bytes: Uint8Array): Promise<string> {
	// Copy into a fresh, exactly-sized ArrayBuffer so a Uint8Array that is a view
	// over a larger buffer (offset/length subrange) hashes its own bytes only.
	const view = new Uint8Array(bytes.byteLength)
	view.set(bytes)
	const digest = await globalThis.crypto.subtle.digest('SHA-256', view)
	const out = new Uint8Array(digest)
	return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Optional metadata carried alongside a blob reference. */
export interface BlobRefMetadata {
	mimeType?: string
	filename?: string
}

/**
 * Create a content-addressed {@link BlobRef} for a byte buffer.
 *
 * @param bytes - The binary content
 * @param metadata - Optional MIME type and filename
 * @returns A reference carrying the content hash, size, and metadata
 */
export async function createBlobRef(
	bytes: Uint8Array,
	metadata: BlobRefMetadata = {},
): Promise<BlobRef> {
	const hash = await hashBlob(bytes)
	const ref: BlobRef = { hash, size: bytes.byteLength }
	if (metadata.mimeType !== undefined) {
		ref.mimeType = metadata.mimeType
	}
	if (metadata.filename !== undefined) {
		ref.filename = metadata.filename
	}
	return ref
}

/**
 * Type guard: whether a value is a structurally valid {@link BlobRef}.
 *
 * Validates the shape only (a non-empty hex hash and a non-negative size); it
 * does not verify that the bytes behind the hash exist or match. Integrity
 * verification against the actual bytes happens in the blob store on read.
 */
export function isBlobRef(value: unknown): value is BlobRef {
	if (typeof value !== 'object' || value === null) {
		return false
	}
	const ref = value as Record<string, unknown>
	if (typeof ref.hash !== 'string' || !/^[0-9a-f]{64}$/.test(ref.hash)) {
		return false
	}
	if (typeof ref.size !== 'number' || !Number.isInteger(ref.size) || ref.size < 0) {
		return false
	}
	if (ref.mimeType !== undefined && typeof ref.mimeType !== 'string') {
		return false
	}
	if (ref.filename !== undefined && typeof ref.filename !== 'string') {
		return false
	}
	if (
		ref.manifestHash !== undefined &&
		(typeof ref.manifestHash !== 'string' || !/^[0-9a-f]{64}$/.test(ref.manifestHash))
	) {
		return false
	}
	return true
}
