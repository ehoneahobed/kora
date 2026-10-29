import { describe, expect, test } from 'vitest'
import { MemoryBlobStore } from './content-addressed-blob-store'
import { FilesystemBlobStore } from './filesystem-blob-store'
import { type OpfsBlobDirectory, OpfsBlobStore } from './opfs-blob-store'

/** Offline readiness reads `durable`: a store that forgets its blobs cannot back kept files. */
describe('ContentAddressedBlobStore.durable', () => {
	test('the in-memory store does not survive a reload', () => {
		expect(new MemoryBlobStore().durable).toBe(false)
	})

	test('the OPFS and filesystem stores do', () => {
		const directory = {} as OpfsBlobDirectory
		expect(new OpfsBlobStore(directory).durable).toBe(true)
		expect(new FilesystemBlobStore('/tmp/does-not-matter').durable).toBe(true)
	})
})
