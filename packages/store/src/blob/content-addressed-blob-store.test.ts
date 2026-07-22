import { hashBlob } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { BlobIntegrityError, MemoryBlobStore } from './content-addressed-blob-store'

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('MemoryBlobStore', () => {
	test('put returns a content-addressed ref and round-trips the bytes', async () => {
		const store = new MemoryBlobStore()
		const content = bytes('hello blob')
		const ref = await store.put(content, { mimeType: 'text/plain', filename: 'h.txt' })

		expect(ref.hash).toBe(await hashBlob(content))
		expect(ref.size).toBe(content.byteLength)
		expect(ref.mimeType).toBe('text/plain')

		const got = await store.get(ref.hash)
		expect(got).not.toBeNull()
		expect(new TextDecoder().decode(got as Uint8Array)).toBe('hello blob')
	})

	test('deduplicates identical content: stored once, same hash', async () => {
		const store = new MemoryBlobStore()
		const a = await store.put(bytes('same'))
		const b = await store.put(bytes('same'))
		expect(a.hash).toBe(b.hash)
		expect(await store.size()).toBe(1)
	})

	test('distinct content is stored separately', async () => {
		const store = new MemoryBlobStore()
		await store.put(bytes('one'))
		await store.put(bytes('two'))
		expect(await store.size()).toBe(2)
	})

	test('has and delete', async () => {
		const store = new MemoryBlobStore()
		const ref = await store.put(bytes('x'))
		expect(await store.has(ref.hash)).toBe(true)
		expect(await store.delete(ref.hash)).toBe(true)
		expect(await store.has(ref.hash)).toBe(false)
		expect(await store.delete(ref.hash)).toBe(false)
	})

	test('get returns null for an unknown hash', async () => {
		const store = new MemoryBlobStore()
		expect(await store.get('a'.repeat(64))).toBeNull()
	})

	test('mutating the input buffer after put does not corrupt the store', async () => {
		const store = new MemoryBlobStore()
		const content = bytes('immutable')
		const ref = await store.put(content)
		content[0] = 0 // mutate caller buffer after storing
		const got = await store.get(ref.hash)
		expect(new TextDecoder().decode(got as Uint8Array)).toBe('immutable')
	})

	test('mutating a returned buffer does not corrupt the store', async () => {
		const store = new MemoryBlobStore()
		const ref = await store.put(bytes('safe'))
		const first = (await store.get(ref.hash)) as Uint8Array
		first[0] = 0
		const second = (await store.get(ref.hash)) as Uint8Array
		expect(new TextDecoder().decode(second)).toBe('safe')
	})

	test('integrity check throws when stored bytes do not match their hash', async () => {
		const store = new MemoryBlobStore()
		const ref = await store.put(bytes('trusted'))
		// Simulate corruption by overwriting the stored bytes for this hash.
		const internal = store as unknown as { blobs: Map<string, Uint8Array> }
		internal.blobs.set(ref.hash, bytes('tampered'))
		await expect(store.get(ref.hash)).rejects.toBeInstanceOf(BlobIntegrityError)
	})
})
