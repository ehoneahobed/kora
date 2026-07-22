import { describe, expect, test } from 'vitest'
import {
	fetchBlobManifest,
	parseBlobManifest,
	putBlobForTransfer,
	resolveBlobManifest,
	serializeBlobManifest,
} from './blob-manifest-transfer'
import { receiveBlob } from './blob-transfer'
import { BlobIntegrityError, MemoryBlobStore } from './content-addressed-blob-store'

function makeBytes(n: number, seed: number): Uint8Array {
	const out = new Uint8Array(n)
	let x = seed >>> 0
	for (let i = 0; i < n; i++) {
		x = (x * 1664525 + 1013904223) >>> 0
		out[i] = (x >>> 24) & 0xff
	}
	return out
}

/** A provider that serves any content-addressed object straight from a store. */
function providerFrom(store: MemoryBlobStore) {
	return { getChunk: (hash: string) => store.get(hash) }
}

describe('blob manifest serialization', () => {
	test('serialize then parse round-trips a manifest, including metadata', () => {
		const manifest = {
			blobHash: 'a'.repeat(64),
			size: 1234,
			chunkSize: 256,
			chunkHashes: ['b'.repeat(64), 'c'.repeat(64)],
			mimeType: 'image/png',
			filename: 'pic.png',
		}
		expect(parseBlobManifest(serializeBlobManifest(manifest))).toEqual(manifest)
	})

	test('serialization is deterministic regardless of object key order', () => {
		const a = { blobHash: 'a'.repeat(64), size: 1, chunkSize: 256, chunkHashes: ['x'.repeat(64)] }
		const b = { chunkHashes: ['x'.repeat(64)], chunkSize: 256, size: 1, blobHash: 'a'.repeat(64) }
		expect(serializeBlobManifest(a)).toEqual(serializeBlobManifest(b))
	})

	test('parse rejects malformed manifest bytes', () => {
		expect(() => parseBlobManifest(new TextEncoder().encode('{"size":1}'))).toThrow(
			'missing blobHash',
		)
	})
})

describe('putBlobForTransfer + manifest resolution', () => {
	test('put stores chunks, blob, and manifest; ref carries the manifestHash', async () => {
		const store = new MemoryBlobStore()
		const bytes = makeBytes(2000, 3)
		const { ref, manifest } = await putBlobForTransfer(store, bytes, {
			chunkSize: 256,
			filename: 'f.bin',
		})

		expect(ref.hash).toBe(manifest.blobHash)
		expect(ref.manifestHash).toBeDefined()
		// The full blob and the manifest are both retrievable by their hashes.
		expect(await store.get(ref.hash)).toEqual(bytes)
		expect(ref.manifestHash).toBeDefined()
		const manifestHash = ref.manifestHash as string
		expect(await store.has(manifestHash)).toBe(true)
	})

	test('resolveBlobManifest fetches the manifest by the ref alone', async () => {
		const store = new MemoryBlobStore()
		const bytes = makeBytes(1500, 4)
		const { ref, manifest } = await putBlobForTransfer(store, bytes, { chunkSize: 256 })

		const resolved = await resolveBlobManifest(providerFrom(store), ref)
		expect(resolved).toEqual(manifest)
	})

	test('a ref with a manifestHash can drive a full receive from a bare provider', async () => {
		// Author stages everything in one store; receiver pulls into another using
		// only the ref (manifest resolved by hash, then chunks fetched).
		const author = new MemoryBlobStore()
		const bytes = makeBytes(3000, 5)
		const { ref } = await putBlobForTransfer(author, bytes, { chunkSize: 256 })

		const provider = providerFrom(author)
		const manifest = await resolveBlobManifest(provider, ref)
		const receiver = new MemoryBlobStore()
		const result = await receiveBlob(manifest, provider, {
			chunkStore: receiver,
			blobStore: receiver,
		})
		expect(result.ref.hash).toBe(ref.hash)
		expect(await receiver.get(ref.hash)).toEqual(bytes)
	})

	test('resolveBlobManifest errors clearly when the ref has no manifestHash', async () => {
		const store = new MemoryBlobStore()
		const ref = await store.put(makeBytes(100, 6)) // bare put, no manifest
		await expect(resolveBlobManifest(providerFrom(store), ref)).rejects.toThrow(
			'has no manifest to resolve',
		)
	})

	test('fetchBlobManifest rejects a manifest whose bytes do not match the hash', async () => {
		const store = new MemoryBlobStore()
		const bytes = makeBytes(500, 7)
		const { ref } = await putBlobForTransfer(store, bytes, { chunkSize: 256 })
		const manifestHash = ref.manifestHash as string

		// Provider that returns wrong bytes for the manifest hash.
		const liar = { getChunk: async () => makeBytes(10, 99) }
		await expect(fetchBlobManifest(liar, manifestHash)).rejects.toBeInstanceOf(BlobIntegrityError)
	})
})
