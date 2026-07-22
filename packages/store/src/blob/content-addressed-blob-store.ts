import { type BlobRef, type BlobRefMetadata, createBlobRef, hashBlob } from '@korajs/core'

/**
 * Thrown when a blob read fails its integrity check: the bytes stored under a
 * hash do not actually hash to that value (corruption or tampering).
 */
export class BlobIntegrityError extends Error {
	constructor(
		readonly expectedHash: string,
		readonly actualHash: string,
	) {
		super(`Blob integrity check failed: content under hash ${expectedHash} hashes to ${actualHash}`)
		this.name = 'BlobIntegrityError'
	}
}

/**
 * A content-addressed store for the bytes behind `blob` fields.
 *
 * Blobs are keyed by the SHA-256 hash of their content, so identical content is
 * stored exactly once (deduplication) and a peer never needs to transfer bytes
 * it already holds. Reads are integrity-checked: the returned bytes are verified
 * to hash to the requested key.
 */
export interface ContentAddressedBlobStore {
	/**
	 * Store bytes and return their content-addressed reference. Storing content
	 * that already exists is a no-op that returns the same reference (dedup).
	 */
	put(bytes: Uint8Array, metadata?: BlobRefMetadata): Promise<BlobRef>
	/**
	 * Retrieve the bytes for a hash, or null if absent. The returned bytes are
	 * verified to hash to the requested value; a mismatch throws
	 * {@link BlobIntegrityError} rather than returning corrupt data.
	 */
	get(hash: string): Promise<Uint8Array | null>
	/** Whether the store holds content for the given hash. */
	has(hash: string): Promise<boolean>
	/** Remove the content for a hash. Returns whether anything was removed. */
	delete(hash: string): Promise<boolean>
	/** Number of distinct blobs held. */
	size(): Promise<number>
	/**
	 * List the hashes of every blob currently held. Used by garbage collection to
	 * find content no live reference points to. Order is unspecified.
	 */
	list(): Promise<string[]>
}

/**
 * In-memory {@link ContentAddressedBlobStore}. The reference backend used for
 * tests and for environments without a persistent blob backend yet. Persistent
 * backends (OPFS client-side, filesystem/S3 server-side) implement the same
 * interface.
 */
export class MemoryBlobStore implements ContentAddressedBlobStore {
	private readonly blobs = new Map<string, Uint8Array>()

	async put(bytes: Uint8Array, metadata: BlobRefMetadata = {}): Promise<BlobRef> {
		const ref = await createBlobRef(bytes, metadata)
		if (!this.blobs.has(ref.hash)) {
			// Copy so later mutation of the caller's buffer cannot corrupt the store.
			const stored = new Uint8Array(bytes.byteLength)
			stored.set(bytes)
			this.blobs.set(ref.hash, stored)
		}
		return ref
	}

	async get(hash: string): Promise<Uint8Array | null> {
		const stored = this.blobs.get(hash)
		if (stored === undefined) {
			return null
		}
		const actualHash = await hashBlob(stored)
		if (actualHash !== hash) {
			throw new BlobIntegrityError(hash, actualHash)
		}
		// Return a copy so callers cannot mutate the stored bytes.
		const out = new Uint8Array(stored.byteLength)
		out.set(stored)
		return out
	}

	async has(hash: string): Promise<boolean> {
		return this.blobs.has(hash)
	}

	async delete(hash: string): Promise<boolean> {
		return this.blobs.delete(hash)
	}

	async size(): Promise<number> {
		return this.blobs.size
	}

	async list(): Promise<string[]> {
		return [...this.blobs.keys()]
	}
}
