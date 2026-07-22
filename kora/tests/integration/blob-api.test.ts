import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

const schema = defineSchema({
	version: 1,
	collections: {
		files: {
			fields: {
				name: t.string(),
				attachment: t.blob(),
			},
		},
	},
})

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('app.blobs facade (local, default backend)', () => {
	let app: KoraApp

	afterEach(async () => {
		if (app) await app.close()
	})

	test('put stores bytes and returns a ref plus a pull manifest', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready

		const content = bytes('the quick brown fox')
		const { ref, manifest } = await app.blobs.put(content, {
			mimeType: 'text/plain',
			filename: 'fox.txt',
		})

		expect(ref.hash).toBe(manifest.blobHash) // ref and manifest agree on identity
		expect(ref.size).toBe(content.byteLength)
		expect(ref.filename).toBe('fox.txt')
		expect(manifest.chunkHashes.length).toBeGreaterThan(0)
	})

	test('get returns stored bytes; has and delete reflect presence', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready

		const content = bytes('attachment body')
		const { ref } = await app.blobs.put(content)

		expect(await app.blobs.has(ref.hash)).toBe(true)
		expect(await app.blobs.get(ref.hash)).toEqual(content)

		expect(await app.blobs.delete(ref.hash)).toBe(true)
		expect(await app.blobs.has(ref.hash)).toBe(false)
		expect(await app.blobs.get(ref.hash)).toBeNull()
	})

	test('a blob ref put into the store can be attached to a record', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready

		const { ref } = await app.blobs.put(bytes('a document'), { filename: 'doc.txt' })
		const files = (app as Record<string, unknown>).files as {
			insert(v: Record<string, unknown>): Promise<{ id: string; attachment: { hash: string } }>
		}
		const record = await files.insert({ name: 'doc', attachment: ref })
		expect(record.attachment.hash).toBe(ref.hash)
	})

	test('pull without a sync connection fails with a clear, actionable error', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready

		const { manifest } = await app.blobs.put(bytes('unreachable'))
		await expect(app.blobs.pull(manifest)).rejects.toThrow('without an active sync connection')
	})

	test('gc collects a blob after its record is deleted, keeps it while referenced', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		const files = (app as Record<string, unknown>).files as {
			insert(v: Record<string, unknown>): Promise<{ id: string }>
			delete(id: string): Promise<void>
		}

		const { ref } = await app.blobs.put(bytes('collect me later'))
		const record = await files.insert({ name: 'doc', attachment: ref })

		// Referenced: gc keeps everything.
		const kept = await app.blobs.gc()
		expect(kept.collected).toBe(0)
		expect(await app.blobs.has(ref.hash)).toBe(true)

		// Delete the record, then gc reclaims the now-orphaned bytes.
		await files.delete(record.id)
		const swept = await app.blobs.gc()
		expect(swept.collected).toBeGreaterThan(0)
		expect(await app.blobs.has(ref.hash)).toBe(false)
	})

	test('gc dryRun reports orphans without deleting', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready

		const { ref } = await app.blobs.put(bytes('orphan from birth'))
		// Never attached to a record → orphaned.
		const preview = await app.blobs.gc({ dryRun: true })
		expect(preview.collected).toBeGreaterThan(0)
		expect(await app.blobs.has(ref.hash)).toBe(true) // dryRun kept it
	})

	test('a custom blob store can be injected via config', async () => {
		const { MemoryBlobStore } = await import('@korajs/store')
		const custom = new MemoryBlobStore()
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			blob: { store: custom },
		})
		await app.ready

		const { ref } = await app.blobs.put(bytes('injected'))
		// The bytes land in the injected store, and app.blobs.store exposes it.
		expect(app.blobs.store).toBe(custom)
		expect(await custom.get(ref.hash)).toEqual(bytes('injected'))
	})
})
