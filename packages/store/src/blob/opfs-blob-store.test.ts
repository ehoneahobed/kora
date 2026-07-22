import { createBlobRef, hashBlob } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { BlobIntegrityError } from './content-addressed-blob-store'
import { type OpfsBlobDirectory, OpfsBlobStore, createOpfsBlobStore } from './opfs-blob-store'

/**
 * In-memory {@link OpfsBlobDirectory} that faithfully models the sharded layout,
 * so the store's content-addressed logic is exercised without a browser. Exposes
 * `corrupt` to simulate on-disk bit-rot for the integrity path.
 */
class FakeOpfsDirectory implements OpfsBlobDirectory {
	private readonly shards = new Map<string, Map<string, Uint8Array>>()

	async read(shard: string, name: string): Promise<Uint8Array | null> {
		const bytes = this.shards.get(shard)?.get(name)
		if (bytes === undefined) {
			return null
		}
		const out = new Uint8Array(bytes.byteLength)
		out.set(bytes)
		return out
	}

	async write(shard: string, name: string, bytes: Uint8Array): Promise<void> {
		let dir = this.shards.get(shard)
		if (!dir) {
			dir = new Map()
			this.shards.set(shard, dir)
		}
		const stored = new Uint8Array(bytes.byteLength)
		stored.set(bytes)
		dir.set(name, stored)
	}

	async remove(shard: string, name: string): Promise<boolean> {
		return this.shards.get(shard)?.delete(name) ?? false
	}

	async has(shard: string, name: string): Promise<boolean> {
		return this.shards.get(shard)?.has(name) ?? false
	}

	async count(): Promise<number> {
		let total = 0
		for (const dir of this.shards.values()) {
			total += dir.size
		}
		return total
	}

	async keys(): Promise<string[]> {
		const names: string[] = []
		for (const dir of this.shards.values()) {
			for (const name of dir.keys()) {
				names.push(name)
			}
		}
		return names
	}

	/** Test-only: overwrite the bytes under a hash to simulate corruption. */
	corrupt(shard: string, name: string, bytes: Uint8Array): void {
		this.shards.get(shard)?.set(name, bytes)
	}

	/** Test-only: which shard a name landed in (to verify sharding). */
	shardKeys(): string[] {
		return [...this.shards.keys()]
	}
}

const text = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('OpfsBlobStore', () => {
	test('put then get round-trips the exact bytes', async () => {
		const dir = new FakeOpfsDirectory()
		const store = new OpfsBlobStore(dir)
		const bytes = text('hello opfs world')

		const ref = await store.put(bytes)
		expect(ref.hash).toBe(await hashBlob(bytes))
		expect(await store.get(ref.hash)).toEqual(bytes)
	})

	test('shards by the first two hash characters', async () => {
		const dir = new FakeOpfsDirectory()
		const store = new OpfsBlobStore(dir)
		const ref = await store.put(text('shard me'))

		expect(dir.shardKeys()).toEqual([ref.hash.slice(0, 2)])
	})

	test('put is deduplicated: identical content stores once', async () => {
		const dir = new FakeOpfsDirectory()
		const store = new OpfsBlobStore(dir)
		const bytes = text('same content')

		const a = await store.put(bytes)
		const b = await store.put(bytes)
		expect(a.hash).toBe(b.hash)
		expect(await store.size()).toBe(1)
	})

	test('get returns null for an unknown hash', async () => {
		const store = new OpfsBlobStore(new FakeOpfsDirectory())
		expect(await store.get('a'.repeat(64))).toBeNull()
	})

	test('has reflects presence, delete removes and reports it', async () => {
		const store = new OpfsBlobStore(new FakeOpfsDirectory())
		const ref = await store.put(text('deletable'))

		expect(await store.has(ref.hash)).toBe(true)
		expect(await store.delete(ref.hash)).toBe(true)
		expect(await store.has(ref.hash)).toBe(false)
		expect(await store.delete(ref.hash)).toBe(false) // second delete is a no-op
	})

	test('get throws BlobIntegrityError when stored bytes do not match the hash', async () => {
		const dir = new FakeOpfsDirectory()
		const store = new OpfsBlobStore(dir)
		const ref = await store.put(text('trustworthy'))

		// Simulate corruption: overwrite the bytes under a valid hash.
		dir.corrupt(ref.hash.slice(0, 2), ref.hash, text('tampered'))
		await expect(store.get(ref.hash)).rejects.toBeInstanceOf(BlobIntegrityError)
	})

	test('preserves the metadata reference contract from createBlobRef', async () => {
		const store = new OpfsBlobStore(new FakeOpfsDirectory())
		const bytes = text('a file')
		const ref = await store.put(bytes, { mimeType: 'text/plain', filename: 'a.txt' })
		const expected = await createBlobRef(bytes, { mimeType: 'text/plain', filename: 'a.txt' })

		expect(ref).toEqual(expected)
	})

	test('drops into the blob transfer store contract (put returns a usable ref)', async () => {
		const store = new OpfsBlobStore(new FakeOpfsDirectory())
		const big = new Uint8Array(1000)
		for (let i = 0; i < big.length; i++) {
			big[i] = (i * 7) & 0xff
		}
		const ref = await store.put(big)
		expect(ref.size).toBe(1000)
		expect(await store.get(ref.hash)).toEqual(big)
	})
})

describe('createOpfsBlobStore (real binding guard)', () => {
	test('throws a clear error when OPFS is unavailable (e.g. in Node)', async () => {
		// No navigator.storage.getDirectory in the test environment.
		await expect(createOpfsBlobStore()).rejects.toThrow('OPFS is unavailable')
	})
})
