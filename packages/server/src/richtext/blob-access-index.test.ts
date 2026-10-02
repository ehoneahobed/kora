import { type Operation, defineSchema, hashBlob, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { BlobAccessIndex } from './blob-access-index'

const schema = defineSchema({
	version: 1,
	collections: {
		files: { fields: { owner: t.string(), doc: t.blob().optional() } },
		notes: { fields: { owner: t.string() } },
	},
})

const enc = (text: string) => new TextEncoder().encode(text)

let seq = 0
function op(overrides: Partial<Operation>): Operation {
	seq += 1
	return {
		id: `op-${seq}`,
		nodeId: 'n',
		type: 'insert',
		collection: 'files',
		recordId: `r-${seq}`,
		data: {},
		previousData: null,
		timestamp: { wallTime: 1000 + seq, logical: 0, nodeId: 'n' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

async function chunked() {
	const chunks = [enc('part one'), enc('part two')]
	const chunkHashes = await Promise.all(chunks.map((c) => hashBlob(c)))
	const manifest = enc(JSON.stringify({ blobHash: 'x', size: 16, chunkSize: 8, chunkHashes }))
	const manifestHash = await hashBlob(manifest)
	const blobHash = await hashBlob(enc('part onepart two'))
	return { chunkHashes, manifest, manifestHash, blobHash }
}

async function storeWith(ref: Record<string, unknown>, owner = 'alice') {
	const store = new MemoryServerStore('s')
	await store.setSchema(schema)
	await store.applyRemoteOperation(op({ recordId: 'f1', data: { owner, doc: ref } }))
	return store
}

const alice = { files: { owner: 'alice' }, notes: { owner: 'alice' } }
const bob = { files: { owner: 'bob' }, notes: { owner: 'bob' } }

describe('BlobAccessIndex (RT-1)', () => {
	test('a hash is referenced only for scopes containing a live record that uses it', async () => {
		const { blobHash } = await chunked()
		const store = await storeWith({ hash: blobHash, size: 16 })
		const index = new BlobAccessIndex(store, null)
		expect(await index.isReferenced(alice, blobHash)).toBe(true)
		expect(await index.isReferenced(bob, blobHash)).toBe(false)
		expect(await index.isReferenced(undefined, blobHash)).toBe(true)
		expect(await index.isReferenced({ notes: {} }, blobHash)).toBe(false)
		expect(await index.isReferenced(alice, 'a'.repeat(64))).toBe(false)
		expect(await index.isReferenced(alice, 'not-a-hash')).toBe(false)
	})

	test('a deleted record no longer grants access after invalidation', async () => {
		const { blobHash } = await chunked()
		const store = await storeWith({ hash: blobHash, size: 16 })
		const index = new BlobAccessIndex(store, null)
		expect(await index.isReferenced(alice, blobHash)).toBe(true)
		await store.applyRemoteOperation(op({ type: 'delete', recordId: 'f1', data: null }))
		index.invalidate()
		expect(await index.isReferenced(alice, blobHash)).toBe(false)
	})

	test('chunks of a referenced manifest are referenced (manifest read from the central store)', async () => {
		const { chunkHashes, manifest, manifestHash, blobHash } = await chunked()
		const store = await storeWith({ hash: blobHash, size: 16, manifestHash })
		const index = new BlobAccessIndex(store, async (h) => (h === manifestHash ? manifest : null))
		expect(await index.isReferenced(alice, manifestHash)).toBe(true)
		for (const chunk of chunkHashes) {
			expect(await index.isReferenced(alice, chunk)).toBe(true)
			expect(await index.isReferenced(bob, chunk)).toBe(false)
		}
	})

	test('chunks are learned from verified manifest bytes in relay mode', async () => {
		const { chunkHashes, manifest, manifestHash, blobHash } = await chunked()
		const store = await storeWith({ hash: blobHash, size: 16, manifestHash })
		const index = new BlobAccessIndex(store, null)
		expect(await index.isReferenced(alice, chunkHashes[0] as string)).toBe(false)
		index.observeVerifiedBytes(manifestHash, manifest)
		expect(await index.isReferenced(alice, chunkHashes[0] as string)).toBe(true)
	})

	test('a manifest from the store that does not hash to its key is not trusted', async () => {
		const { chunkHashes, manifestHash, blobHash } = await chunked()
		const store = await storeWith({ hash: blobHash, size: 16, manifestHash })
		const forged = enc(JSON.stringify({ chunkHashes: ['c'.repeat(64)] }))
		const index = new BlobAccessIndex(store, async () => forged)
		expect(await index.isReferenced(alice, 'c'.repeat(64))).toBe(false)
		expect(await index.isReferenced(alice, chunkHashes[0] as string)).toBe(false)
	})
})
