import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type BlobRef, type BlobRefMetadata, createBlobRef, hashBlob } from '@korajs/core'
import { BlobIntegrityError, type ContentAddressedBlobStore } from './content-addressed-blob-store'

/**
 * A persistent {@link ContentAddressedBlobStore} backed by the filesystem.
 *
 * Node-only (exported from `@korajs/store/blob-fs` so it never enters a browser
 * bundle). Blobs are stored at `<dir>/<hash[0:2]>/<hash>`, sharded by hash prefix
 * so a single directory never holds millions of entries. Writes are atomic (write
 * to a temp file, then rename) so a crash mid-write cannot leave a half-written
 * blob under a valid hash. Reads verify the bytes hash to the requested key.
 *
 * This is the same content-addressed contract as {@link MemoryBlobStore}, so it
 * drops into the blob transfer path (chunk staging, blob destination) unchanged.
 */
export class FilesystemBlobStore implements ContentAddressedBlobStore {
	constructor(private readonly dir: string) {}

	private pathFor(hash: string): string {
		return join(this.dir, hash.slice(0, 2), hash)
	}

	async put(bytes: Uint8Array, metadata: BlobRefMetadata = {}): Promise<BlobRef> {
		const ref = await createBlobRef(bytes, metadata)
		const target = this.pathFor(ref.hash)

		// Dedup: identical content already stored is a no-op.
		if (await this.exists(target)) {
			return ref
		}

		await mkdir(dirname(target), { recursive: true })
		// Copy into an exactly-sized buffer so a subarray view writes its own bytes.
		const out = new Uint8Array(bytes.byteLength)
		out.set(bytes)
		// Atomic write: temp file then rename, so a crash never leaves a partial
		// blob under a hash that readers would then trust.
		const tmp = `${target}.${randomUUID()}.tmp`
		await writeFile(tmp, out)
		await rename(tmp, target)
		return ref
	}

	async get(hash: string): Promise<Uint8Array | null> {
		let contents: Buffer
		try {
			contents = await readFile(this.pathFor(hash))
		} catch (error) {
			if (isNotFound(error)) {
				return null
			}
			throw error
		}
		const bytes = new Uint8Array(contents)
		const actual = await hashBlob(bytes)
		if (actual !== hash) {
			throw new BlobIntegrityError(hash, actual)
		}
		return bytes
	}

	async has(hash: string): Promise<boolean> {
		return this.exists(this.pathFor(hash))
	}

	async delete(hash: string): Promise<boolean> {
		const target = this.pathFor(hash)
		if (!(await this.exists(target))) {
			return false
		}
		await rm(target)
		return true
	}

	async size(): Promise<number> {
		let count = 0
		let shards: string[]
		try {
			shards = await readdir(this.dir)
		} catch (error) {
			if (isNotFound(error)) {
				return 0
			}
			throw error
		}
		for (const shard of shards) {
			try {
				const entries = await readdir(join(this.dir, shard))
				count += entries.filter((name) => !name.endsWith('.tmp')).length
			} catch (error) {
				if (!isNotFound(error)) {
					throw error
				}
			}
		}
		return count
	}

	async list(): Promise<string[]> {
		let shards: string[]
		try {
			shards = await readdir(this.dir)
		} catch (error) {
			if (isNotFound(error)) {
				return []
			}
			throw error
		}
		const hashes: string[] = []
		for (const shard of shards) {
			try {
				const entries = await readdir(join(this.dir, shard))
				for (const name of entries) {
					if (!name.endsWith('.tmp')) {
						hashes.push(name)
					}
				}
			} catch (error) {
				if (!isNotFound(error)) {
					throw error
				}
			}
		}
		return hashes
	}

	private async exists(path: string): Promise<boolean> {
		try {
			await stat(path)
			return true
		} catch (error) {
			if (isNotFound(error)) {
				return false
			}
			throw error
		}
	}
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
	)
}
