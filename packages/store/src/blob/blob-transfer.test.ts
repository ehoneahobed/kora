import { createBlobRef, hashBlob } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { chunkBlob, reassembleBlob } from './blob-chunking'
import { type ChunkProvider, prepareBlobForSend, receiveBlob } from './blob-transfer'
import {
	BlobIntegrityError,
	type ContentAddressedBlobStore,
	MemoryBlobStore,
} from './content-addressed-blob-store'

function randomBytes(n: number, seed: number): Uint8Array {
	// Deterministic pseudo-random bytes (no Math.random — reproducible tests).
	// Use the HIGH byte of the LCG: an LCG's low-order bits have a very short
	// period (the low 8 bits repeat within 256 steps), which would produce
	// duplicate chunks; the high byte has the full period.
	const out = new Uint8Array(n)
	let x = seed >>> 0
	for (let i = 0; i < n; i++) {
		x = (x * 1664525 + 1013904223) >>> 0
		out[i] = (x >>> 24) & 0xff
	}
	return out
}

/** A chunk provider that counts how many chunks it served. */
function countingProvider(store: ContentAddressedBlobStore): ChunkProvider & { served: number } {
	const p = {
		served: 0,
		async getChunk(hash: string): Promise<Uint8Array | null> {
			const bytes = await store.get(hash)
			if (bytes !== null) {
				p.served++
			}
			return bytes
		},
	}
	return p
}

describe('chunkBlob / reassembleBlob', () => {
	test('round-trips a multi-chunk blob', async () => {
		const bytes = randomBytes(1000, 7)
		const { manifest, chunks } = await chunkBlob(bytes, 256)
		expect(manifest.chunkHashes.length).toBe(4) // 256*3 + 232
		expect(manifest.size).toBe(1000)
		expect(manifest.blobHash).toBe(await hashBlob(bytes))

		const store = new MemoryBlobStore()
		for (const chunk of chunks.values()) {
			await store.put(chunk)
		}
		const out = await reassembleBlob(manifest, store)
		expect(out).toEqual(bytes)
	})

	test('handles an empty blob (zero chunks)', async () => {
		const { manifest } = await chunkBlob(new Uint8Array(0), 256)
		expect(manifest.chunkHashes).toEqual([])
		const out = await reassembleBlob(manifest, new MemoryBlobStore())
		expect(out.byteLength).toBe(0)
	})

	test('deduplicates identical chunks in the chunk map', async () => {
		// 512 bytes of the same repeated 256-byte block → two identical chunks.
		const block = randomBytes(256, 3)
		const bytes = new Uint8Array(512)
		bytes.set(block, 0)
		bytes.set(block, 256)
		const { manifest, chunks } = await chunkBlob(bytes, 256)
		expect(manifest.chunkHashes.length).toBe(2)
		expect(manifest.chunkHashes[0]).toBe(manifest.chunkHashes[1])
		expect(chunks.size).toBe(1) // stored once
	})

	test('reassembly rejects a tampered chunk via the store integrity check', async () => {
		const bytes = randomBytes(500, 9)
		const { manifest, chunks } = await chunkBlob(bytes, 256)
		const store = new MemoryBlobStore()
		for (const chunk of chunks.values()) {
			await store.put(chunk)
		}
		// Corrupt one chunk's stored bytes under its hash.
		const firstHash = manifest.chunkHashes[0] as string
		;(store as unknown as { blobs: Map<string, Uint8Array> }).blobs.set(
			firstHash,
			new Uint8Array([1, 2, 3]),
		)
		await expect(reassembleBlob(manifest, store)).rejects.toBeInstanceOf(BlobIntegrityError)
	})
})

describe('receiveBlob (resumable out-of-band transfer)', () => {
	test('transfers a blob end to end and yields the correct reference', async () => {
		const bytes = randomBytes(2000, 11)
		const senderChunks = new MemoryBlobStore()
		const { manifest, provider } = await prepareBlobForSend(bytes, senderChunks, {
			chunkSize: 256,
			mimeType: 'application/octet-stream',
			filename: 'blob.bin',
		})

		const chunkStore = new MemoryBlobStore()
		const blobStore = new MemoryBlobStore()
		const result = await receiveBlob(manifest, provider, { chunkStore, blobStore })

		const expected = await createBlobRef(bytes, {
			mimeType: 'application/octet-stream',
			filename: 'blob.bin',
		})
		expect(result.ref).toEqual(expected)
		const stored = await blobStore.get(result.ref.hash)
		expect(stored).toEqual(bytes)
	})

	test('is resumable: a second run after partial progress fetches only the rest', async () => {
		const bytes = randomBytes(2000, 13)
		const senderChunks = new MemoryBlobStore()
		const { manifest, provider: base } = await prepareBlobForSend(bytes, senderChunks, {
			chunkSize: 256,
		})
		const provider = countingProvider(senderChunks)

		// First transfer: interrupt after the first 3 chunks by using a provider
		// that throws once it has served 3.
		const chunkStore = new MemoryBlobStore()
		const blobStore = new MemoryBlobStore()
		let served = 0
		const flaky: ChunkProvider = {
			async getChunk(hash) {
				if (served >= 3) {
					throw new Error('connection dropped')
				}
				served++
				return base.getChunk(hash)
			},
		}
		await expect(receiveBlob(manifest, flaky, { chunkStore, blobStore })).rejects.toThrow(
			'connection dropped',
		)
		expect(await chunkStore.size()).toBe(3) // 3 chunks staged before the drop

		// Resume with a healthy provider: only the remaining chunks are fetched.
		const result = await receiveBlob(manifest, provider, { chunkStore, blobStore })
		expect(result.chunksSkipped).toBe(3) // the 3 already staged
		expect(result.chunksFetched).toBe(manifest.chunkHashes.length - 3)
		expect(await blobStore.get(result.ref.hash)).toEqual(bytes)
	})

	test('is idempotent: re-running a completed transfer fetches nothing', async () => {
		const bytes = randomBytes(800, 17)
		const senderChunks = new MemoryBlobStore()
		const { manifest, provider } = await prepareBlobForSend(bytes, senderChunks, { chunkSize: 256 })
		const chunkStore = new MemoryBlobStore()
		const blobStore = new MemoryBlobStore()

		const first = await receiveBlob(manifest, provider, { chunkStore, blobStore })
		const second = await receiveBlob(manifest, provider, { chunkStore, blobStore })
		expect(second.chunksFetched).toBe(0)
		expect(second.chunksSkipped).toBe(manifest.chunkHashes.length)
		expect(second.ref).toEqual(first.ref)
	})

	test('rejects a chunk whose bytes do not match the requested hash', async () => {
		const bytes = randomBytes(500, 19)
		const senderChunks = new MemoryBlobStore()
		const { manifest } = await prepareBlobForSend(bytes, senderChunks, { chunkSize: 256 })
		// A malicious/broken provider that returns wrong bytes for any hash.
		const badProvider: ChunkProvider = {
			async getChunk() {
				return new Uint8Array([9, 9, 9])
			},
		}
		await expect(
			receiveBlob(manifest, badProvider, {
				chunkStore: new MemoryBlobStore(),
				blobStore: new MemoryBlobStore(),
			}),
		).rejects.toBeInstanceOf(BlobIntegrityError)
	})

	test('throws when the provider cannot supply a required chunk', async () => {
		const bytes = randomBytes(500, 23)
		const senderChunks = new MemoryBlobStore()
		const { manifest } = await prepareBlobForSend(bytes, senderChunks, { chunkSize: 256 })
		const emptyProvider: ChunkProvider = {
			async getChunk() {
				return null
			},
		}
		await expect(
			receiveBlob(manifest, emptyProvider, {
				chunkStore: new MemoryBlobStore(),
				blobStore: new MemoryBlobStore(),
			}),
		).rejects.toThrow('could not supply chunk')
	})
})
