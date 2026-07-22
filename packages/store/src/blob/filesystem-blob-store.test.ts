import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashBlob } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BlobIntegrityError } from './content-addressed-blob-store'
import { FilesystemBlobStore } from './filesystem-blob-store'

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

let dir: string

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'kora-blob-'))
})

afterEach(async () => {
	await rm(dir, { recursive: true, force: true })
})

describe('FilesystemBlobStore', () => {
	test('put returns a content-addressed ref and round-trips bytes from disk', async () => {
		const store = new FilesystemBlobStore(dir)
		const content = bytes('persisted blob')
		const ref = await store.put(content, { mimeType: 'text/plain' })
		expect(ref.hash).toBe(await hashBlob(content))
		const got = await store.get(ref.hash)
		expect(new TextDecoder().decode(got as Uint8Array)).toBe('persisted blob')
	})

	test('persists across store instances (survives a "restart")', async () => {
		const ref = await new FilesystemBlobStore(dir).put(bytes('durable'))
		// A fresh store over the same directory still sees the blob.
		const reopened = new FilesystemBlobStore(dir)
		expect(await reopened.has(ref.hash)).toBe(true)
		expect(new TextDecoder().decode((await reopened.get(ref.hash)) as Uint8Array)).toBe('durable')
	})

	test('deduplicates identical content on disk', async () => {
		const store = new FilesystemBlobStore(dir)
		const a = await store.put(bytes('same'))
		const b = await store.put(bytes('same'))
		expect(a.hash).toBe(b.hash)
		expect(await store.size()).toBe(1)
	})

	test('stores distinct content separately', async () => {
		const store = new FilesystemBlobStore(dir)
		await store.put(bytes('one'))
		await store.put(bytes('two'))
		expect(await store.size()).toBe(2)
	})

	test('has and delete', async () => {
		const store = new FilesystemBlobStore(dir)
		const ref = await store.put(bytes('x'))
		expect(await store.has(ref.hash)).toBe(true)
		expect(await store.delete(ref.hash)).toBe(true)
		expect(await store.has(ref.hash)).toBe(false)
		expect(await store.delete(ref.hash)).toBe(false)
	})

	test('get returns null for an unknown hash', async () => {
		const store = new FilesystemBlobStore(dir)
		expect(await store.get('a'.repeat(64))).toBeNull()
	})

	test('size is zero for an empty (never-written) store', async () => {
		expect(await new FilesystemBlobStore(join(dir, 'nested', 'missing')).size()).toBe(0)
	})

	test('integrity check throws when on-disk bytes do not match their hash', async () => {
		const store = new FilesystemBlobStore(dir)
		const ref = await store.put(bytes('trusted'))
		// Corrupt the on-disk file for this hash by writing different bytes to a
		// blob whose real hash differs, then asking for the original hash back.
		const other = await store.put(bytes('tampered'))
		// Overwrite the trusted file's bytes with the tampered content on disk.
		const { writeFile } = await import('node:fs/promises')
		const { join: pjoin } = await import('node:path')
		await writeFile(pjoin(dir, ref.hash.slice(0, 2), ref.hash), bytes('tampered'))
		await expect(store.get(ref.hash)).rejects.toBeInstanceOf(BlobIntegrityError)
		// The genuinely-stored 'tampered' blob (under its own correct hash) is fine.
		expect(await store.get(other.hash)).not.toBeNull()
	})
})
