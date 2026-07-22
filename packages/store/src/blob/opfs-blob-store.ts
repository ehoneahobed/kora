import { type BlobRef, type BlobRefMetadata, createBlobRef, hashBlob } from '@korajs/core'
import { BlobIntegrityError, type ContentAddressedBlobStore } from './content-addressed-blob-store'

/**
 * The minimal directory abstraction an {@link OpfsBlobStore} needs. Blobs are
 * laid out as `<shard>/<name>` (shard = first two hex chars of the hash) so a
 * single directory never holds millions of entries.
 *
 * The real backend ({@link createOpfsBlobDirectory}) is the browser Origin
 * Private File System; tests supply an in-memory implementation. Keeping this
 * port small means the content-addressed logic (hashing, integrity, dedup,
 * sharding) is fully testable without a browser.
 */
export interface OpfsBlobDirectory {
	/** Read the bytes at `<shard>/<name>`, or null if absent. */
	read(shard: string, name: string): Promise<Uint8Array | null>
	/**
	 * Write bytes at `<shard>/<name>`, creating the shard directory as needed.
	 * Must be atomic: a crash mid-write may not leave a partially-written file
	 * that a later read would trust.
	 */
	write(shard: string, name: string, bytes: Uint8Array): Promise<void>
	/** Remove `<shard>/<name>`. Returns whether anything was removed. */
	remove(shard: string, name: string): Promise<boolean>
	/** Whether `<shard>/<name>` exists. */
	has(shard: string, name: string): Promise<boolean>
	/** Count of stored blobs across all shards (temp files excluded). */
	count(): Promise<number>
	/** Every stored blob name (hash) across all shards (temp files excluded). */
	keys(): Promise<string[]>
}

/**
 * A persistent {@link ContentAddressedBlobStore} for the browser, backed by the
 * Origin Private File System (OPFS) — the same durable storage the SQLite WASM
 * adapter uses. Blobs survive reloads, are sharded by hash prefix, deduplicated,
 * and integrity-verified on read (the returned bytes are checked to hash to the
 * requested key). Writes commit atomically so a torn write cannot surface as
 * trusted data.
 *
 * The store itself is environment-neutral: it talks to an {@link OpfsBlobDirectory}.
 * Use {@link createOpfsBlobStore} in a browser to get one backed by real OPFS.
 */
export class OpfsBlobStore implements ContentAddressedBlobStore {
	constructor(private readonly dir: OpfsBlobDirectory) {}

	private shardFor(hash: string): string {
		// Two hex chars → 256 shards. Hashes are hex, so this is always well-formed.
		return hash.slice(0, 2)
	}

	async put(bytes: Uint8Array, metadata: BlobRefMetadata = {}): Promise<BlobRef> {
		const ref = await createBlobRef(bytes, metadata)
		const shard = this.shardFor(ref.hash)

		// Dedup: identical content already stored is a no-op.
		if (await this.dir.has(shard, ref.hash)) {
			return ref
		}

		// Copy into an exactly-sized buffer so a subarray view writes its own bytes.
		const out = new Uint8Array(bytes.byteLength)
		out.set(bytes)
		await this.dir.write(shard, ref.hash, out)
		return ref
	}

	async get(hash: string): Promise<Uint8Array | null> {
		const bytes = await this.dir.read(this.shardFor(hash), hash)
		if (bytes === null) {
			return null
		}
		const actual = await hashBlob(bytes)
		if (actual !== hash) {
			throw new BlobIntegrityError(hash, actual)
		}
		return bytes
	}

	async has(hash: string): Promise<boolean> {
		return this.dir.has(this.shardFor(hash), hash)
	}

	async delete(hash: string): Promise<boolean> {
		return this.dir.remove(this.shardFor(hash), hash)
	}

	async size(): Promise<number> {
		return this.dir.count()
	}

	async list(): Promise<string[]> {
		return this.dir.keys()
	}
}

// --- Real OPFS binding (browser only) ---

/** Minimal structural views of the File System Access handles we use. */
interface OpfsWritableStream {
	write(data: Uint8Array): Promise<void>
	close(): Promise<void>
}
interface OpfsFileHandle {
	createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritableStream>
	getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>
}
interface OpfsDirectoryHandle {
	getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>
	getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>
	removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
	keys(): AsyncIterableIterator<string>
}

interface StorageManagerLike {
	getDirectory(): Promise<OpfsDirectoryHandle>
	persist?(): Promise<boolean>
}

function getStorageManager(): StorageManagerLike {
	const nav = (globalThis as { navigator?: { storage?: StorageManagerLike } }).navigator
	if (!nav?.storage || typeof nav.storage.getDirectory !== 'function') {
		throw new Error(
			'OPFS is unavailable in this environment. The OPFS blob store requires a browser with Origin Private File System support; use MemoryBlobStore or a server-side store elsewhere.',
		)
	}
	return nav.storage
}

function isNotFoundError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { name?: string }).name === 'NotFoundError'
	)
}

/**
 * Create an {@link OpfsBlobDirectory} backed by the browser's Origin Private
 * File System, rooted at a named subdirectory. Best-effort requests persistent
 * storage so the browser is less likely to evict blobs under storage pressure.
 *
 * @param rootDirName - The OPFS subdirectory to store blobs under (default `kora-blobs`)
 * @throws {Error} If OPFS is unavailable (e.g. called outside a browser)
 */
export async function createOpfsBlobDirectory(
	rootDirName = 'kora-blobs',
): Promise<OpfsBlobDirectory> {
	const storage = getStorageManager()
	// Best-effort durability: ask the browser not to evict this origin's storage.
	if (typeof storage.persist === 'function') {
		try {
			await storage.persist()
		} catch {
			// Persistence is an optimization, not a requirement; ignore failures.
		}
	}
	const opfsRoot = await storage.getDirectory()
	const root = await opfsRoot.getDirectoryHandle(rootDirName, { create: true })

	async function shardHandle(shard: string, create: boolean): Promise<OpfsDirectoryHandle | null> {
		try {
			return await root.getDirectoryHandle(shard, { create })
		} catch (error) {
			if (isNotFoundError(error)) {
				return null
			}
			throw error
		}
	}

	return {
		async read(shard, name) {
			const dir = await shardHandle(shard, false)
			if (!dir) {
				return null
			}
			let handle: OpfsFileHandle
			try {
				handle = await dir.getFileHandle(name, { create: false })
			} catch (error) {
				if (isNotFoundError(error)) {
					return null
				}
				throw error
			}
			const file = await handle.getFile()
			return new Uint8Array(await file.arrayBuffer())
		},
		async write(shard, name, bytes) {
			const dir = await root.getDirectoryHandle(shard, { create: true })
			const handle = await dir.getFileHandle(name, { create: true })
			// createWritable buffers to a swap file and only commits on close(), so
			// the target file is updated atomically. Combined with integrity-on-read,
			// a torn write is never trusted.
			const writable = await handle.createWritable({ keepExistingData: false })
			try {
				await writable.write(bytes)
			} finally {
				await writable.close()
			}
		},
		async remove(shard, name) {
			const dir = await shardHandle(shard, false)
			if (!dir) {
				return false
			}
			try {
				await dir.removeEntry(name)
				return true
			} catch (error) {
				if (isNotFoundError(error)) {
					return false
				}
				throw error
			}
		},
		async has(shard, name) {
			const dir = await shardHandle(shard, false)
			if (!dir) {
				return false
			}
			try {
				await dir.getFileHandle(name, { create: false })
				return true
			} catch (error) {
				if (isNotFoundError(error)) {
					return false
				}
				throw error
			}
		},
		async count() {
			let total = 0
			for await (const shard of root.keys()) {
				const dir = await shardHandle(shard, false)
				if (!dir) {
					continue
				}
				for await (const name of dir.keys()) {
					if (!name.endsWith('.tmp')) {
						total++
					}
				}
			}
			return total
		},
		async keys() {
			const names: string[] = []
			for await (const shard of root.keys()) {
				const dir = await shardHandle(shard, false)
				if (!dir) {
					continue
				}
				for await (const name of dir.keys()) {
					if (!name.endsWith('.tmp')) {
						names.push(name)
					}
				}
			}
			return names
		},
	}
}

/**
 * Create a persistent {@link OpfsBlobStore} backed by real browser OPFS.
 *
 * @param rootDirName - The OPFS subdirectory to store blobs under (default `kora-blobs`)
 * @throws {Error} If OPFS is unavailable (e.g. called outside a browser)
 */
export async function createOpfsBlobStore(rootDirName = 'kora-blobs'): Promise<OpfsBlobStore> {
	return new OpfsBlobStore(await createOpfsBlobDirectory(rootDirName))
}
