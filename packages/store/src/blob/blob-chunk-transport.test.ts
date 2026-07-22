import { describe, expect, test } from 'vitest'
import {
	createChunkPortPair,
	createRemoteChunkProvider,
	serveBlobChunks,
} from './blob-chunk-transport'
import { prepareBlobForSend, receiveBlob } from './blob-transfer'
import { MemoryBlobStore } from './content-addressed-blob-store'

function randomBytes(n: number, seed: number): Uint8Array {
	const out = new Uint8Array(n)
	let x = seed >>> 0
	for (let i = 0; i < n; i++) {
		x = (x * 1664525 + 1013904223) >>> 0
		out[i] = (x >>> 24) & 0xff
	}
	return out
}

describe('blob chunk transport (request/response over a message port)', () => {
	test('a receiver pulls a blob chunk-by-chunk over the port and reassembles it', async () => {
		const bytes = randomBytes(2000, 5)

		// Server side: stage the blob's chunks and serve chunk requests over its port.
		const serverStore = new MemoryBlobStore()
		const { manifest } = await prepareBlobForSend(bytes, serverStore, { chunkSize: 256 })
		const pair = createChunkPortPair()
		serveBlobChunks(pair.a, serverStore)

		// Receiver side: a provider backed by the other end of the port.
		const provider = createRemoteChunkProvider(pair.b)
		const chunkStore = new MemoryBlobStore()
		const blobStore = new MemoryBlobStore()

		const result = await receiveBlob(manifest, provider, { chunkStore, blobStore })
		expect(result.ref.hash).toBe(manifest.blobHash)
		expect(await blobStore.get(result.ref.hash)).toEqual(bytes)
		expect(provider.pendingCount()).toBe(0) // every request resolved
	})

	test('resumes over the port: a second pull fetches only the missing chunks', async () => {
		const bytes = randomBytes(2000, 6)
		const serverStore = new MemoryBlobStore()
		const { manifest } = await prepareBlobForSend(bytes, serverStore, { chunkSize: 256 })
		const pair = createChunkPortPair()
		serveBlobChunks(pair.a, serverStore)
		const provider = createRemoteChunkProvider(pair.b)

		const chunkStore = new MemoryBlobStore()
		const blobStore = new MemoryBlobStore()

		// Pre-stage the first two chunks locally (as if a prior transfer was cut off).
		const staged = await prepareBlobForSend(bytes, new MemoryBlobStore(), { chunkSize: 256 })
		const firstTwo = staged.manifest.chunkHashes.slice(0, 2)
		for (const hash of firstTwo) {
			const chunk = await serverStore.get(hash)
			if (chunk) {
				await chunkStore.put(chunk)
			}
		}

		const result = await receiveBlob(manifest, provider, { chunkStore, blobStore })
		expect(result.chunksSkipped).toBe(2)
		expect(result.chunksFetched).toBe(manifest.chunkHashes.length - 2)
		expect(await blobStore.get(result.ref.hash)).toEqual(bytes)
	})

	test('a missing chunk on the server surfaces as unavailable, not a hang', async () => {
		// Manifest references a chunk the server does not have.
		const bytes = randomBytes(500, 7)
		const senderStore = new MemoryBlobStore()
		const { manifest } = await prepareBlobForSend(bytes, senderStore, { chunkSize: 256 })

		const emptyServerStore = new MemoryBlobStore() // holds nothing
		const pair = createChunkPortPair()
		serveBlobChunks(pair.a, emptyServerStore)
		const provider = createRemoteChunkProvider(pair.b)

		await expect(
			receiveBlob(manifest, provider, {
				chunkStore: new MemoryBlobStore(),
				blobStore: new MemoryBlobStore(),
			}),
		).rejects.toThrow('could not supply chunk')
	})

	test('a corrupt chunk on the server is reported as unavailable (integrity guard)', async () => {
		const bytes = randomBytes(300, 9)
		const serverStore = new MemoryBlobStore()
		const { manifest } = await prepareBlobForSend(bytes, serverStore, { chunkSize: 256 })
		// Corrupt the stored bytes for the first chunk so the server's get() throws.
		const firstHash = manifest.chunkHashes[0] as string
		;(serverStore as unknown as { blobs: Map<string, Uint8Array> }).blobs.set(
			firstHash,
			new Uint8Array([0, 0, 0]),
		)
		const pair = createChunkPortPair()
		serveBlobChunks(pair.a, serverStore)
		const provider = createRemoteChunkProvider(pair.b)

		// The server answers null for the corrupt chunk → receiver reports unavailable.
		await expect(
			receiveBlob(manifest, provider, {
				chunkStore: new MemoryBlobStore(),
				blobStore: new MemoryBlobStore(),
			}),
		).rejects.toThrow('could not supply chunk')
	})
})
