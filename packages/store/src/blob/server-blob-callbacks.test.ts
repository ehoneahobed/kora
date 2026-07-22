import { hashBlob } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MemoryBlobStore } from './content-addressed-blob-store'
import { createMemoryServerBlobStore, toServerBlobCallbacks } from './server-blob-callbacks'

const text = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('toServerBlobCallbacks', () => {
	test('persist stores bytes, resolve reads them back by hash', async () => {
		const store = new MemoryBlobStore()
		const { resolveBlobChunk, persistBlobChunk } = toServerBlobCallbacks(store)
		const bytes = text('server-held blob')
		const hash = await hashBlob(bytes)

		expect(await resolveBlobChunk(hash)).toBeNull()
		await persistBlobChunk(hash, bytes)
		expect(await resolveBlobChunk(hash)).toEqual(bytes)
	})

	test('persist rejects bytes that do not hash to the declared hash', async () => {
		const store = new MemoryBlobStore()
		const { resolveBlobChunk, persistBlobChunk } = toServerBlobCallbacks(store)

		await persistBlobChunk('a'.repeat(64), text('mismatched'))
		// Nothing was stored under the false hash.
		expect(await resolveBlobChunk('a'.repeat(64))).toBeNull()
		expect(await store.size()).toBe(0)
	})

	test('createMemoryServerBlobStore exposes the store and its callbacks', async () => {
		const { store, callbacks } = createMemoryServerBlobStore()
		const bytes = text('paired')
		const hash = await hashBlob(bytes)
		await callbacks.persistBlobChunk(hash, bytes)
		expect(await store.get(hash)).toEqual(bytes)
	})
})
