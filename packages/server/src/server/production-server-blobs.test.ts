import { mkdtemp, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesystemBlobStore } from '@korajs/store/blob-fs'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { createProductionServer, resolveServerBlobStore } from './production-server'

describe('where a production server keeps file bytes', () => {
	test('the host decides by default: KORA_BLOB_DIR gives a directory store', () => {
		const store = resolveServerBlobStore({}, { KORA_BLOB_DIR: '/tmp/kora-files' })
		expect(store).toBeInstanceOf(FilesystemBlobStore)
	})

	test('no setting keeps no bytes; false keeps none; a store passed in code wins', () => {
		expect(resolveServerBlobStore({}, {})).toBeNull()
		expect(resolveServerBlobStore({ blobStore: false }, { KORA_BLOB_DIR: '/tmp/x' })).toBeNull()
		const mine = new FilesystemBlobStore('/tmp/mine')
		expect(resolveServerBlobStore({ blobStore: mine }, { KORA_BLOB_DIR: '/tmp/x' })).toBe(mine)
	})

	test('an app that wires blob handling itself is left alone', () => {
		const syncOptions = { persistBlobChunk: async () => undefined }
		expect(resolveServerBlobStore({ syncOptions }, { KORA_BLOB_DIR: '/tmp/x' })).toBeNull()
	})
})

describe('the daily sweep of unused file bytes', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	test('runs on its own when the server holds the bytes, keeping recent uploads', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
		const dir = await mkdtemp(join(tmpdir(), 'kora-sweep-'))
		const files = new FilesystemBlobStore(dir)
		const old = await files.put(new TextEncoder().encode('unused for two days'))
		const recent = await files.put(new TextEncoder().encode('uploaded a moment ago'))
		const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
		await utimes(join(dir, old.hash.slice(0, 2), old.hash), twoDaysAgo, twoDaysAgo)

		const server = createProductionServer({
			store: new MemoryServerStore(),
			blobStore: files,
			port: 0,
			staticDir: dir,
		})
		await server.start()
		try {
			await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
			await vi.waitFor(async () => expect(await files.has(old.hash)).toBe(false), {
				timeout: 5_000,
			})
			expect(await files.has(recent.hash)).toBe(true)
		} finally {
			await server.stop()
		}
	})
})
