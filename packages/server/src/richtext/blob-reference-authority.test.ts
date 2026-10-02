import { type Operation, defineSchema, hashBlob, t } from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { createSqliteServerStore } from '../store/sqlite-server-store'
import { BlobAccessIndex, referencedHashes } from './blob-access-index'

const schema = defineSchema({
	version: 1,
	collections: {
		files: { fields: { owner: t.string(), doc: t.blob().optional() } },
		notes: { fields: { owner: t.string() } },
	},
})

const enc = (text: string) => new TextEncoder().encode(text)
const alice = { files: { owner: 'alice' }, notes: { owner: 'alice' } }
const bob = { files: { owner: 'bob' }, notes: { owner: 'bob' } }

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

async function memoryStore() {
	const store = new MemoryServerStore('s')
	await store.setSchema(schema)
	return store
}

describe('BlobAccessIndex reference authority (RT-11)', () => {
	test('a hash nobody references, owns or stores is claimed by its first writer', async () => {
		const index = new BlobAccessIndex(await memoryStore(), null)
		const hash = 'a'.repeat(64)
		expect(await index.authorizeReference({ hash, scopes: alice, owner: 'alice' })).toBe(true)
		// The claim sticks: the next writer is someone else and is refused...
		expect(await index.authorizeReference({ hash, scopes: bob, owner: 'bob' })).toBe(false)
		// ...while the claimant may reference it again.
		expect(await index.authorizeReference({ hash, scopes: alice, owner: 'alice' })).toBe(true)
	})

	test("a hash referenced in another tenant's scope is refused; in the writer's own, allowed", async () => {
		const store = await memoryStore()
		const hash = 'b'.repeat(64)
		await store.applyRemoteOperation(op({ data: { owner: 'alice', doc: { hash, size: 1 } } }))
		const index = new BlobAccessIndex(store, null)
		expect(await index.authorizeReference({ hash, scopes: bob, owner: 'bob' })).toBe(false)
		expect(await index.authorizeReference({ hash, scopes: alice, owner: 'alice-2' })).toBe(true)
	})

	test('pushing the bytes proves possession', async () => {
		const store = await memoryStore()
		const bytes = enc('shared logo')
		const hash = await hashBlob(bytes)
		await store.applyRemoteOperation(op({ data: { owner: 'alice', doc: { hash, size: 1 } } }))
		const index = new BlobAccessIndex(store, null)
		expect(await index.authorizeReference({ hash, scopes: bob, owner: 'bob' })).toBe(false)
		await index.recordPush(hash, bytes, 'bob')
		expect(await index.authorizeReference({ hash, scopes: bob, owner: 'bob' })).toBe(true)
	})

	test('unowned bytes already in the central store are not claimable by naming their hash', async () => {
		const bytes = enc('legacy upload')
		const hash = await hashBlob(bytes)
		const index = new BlobAccessIndex(await memoryStore(), async (h) => (h === hash ? bytes : null))
		expect(await index.authorizeReference({ hash, scopes: bob, owner: 'bob' })).toBe(false)
	})

	test('an unchanged reference on the written record is always allowed', async () => {
		const index = new BlobAccessIndex(await memoryStore(), null)
		const hash = 'c'.repeat(64)
		await index.authorizeReference({ hash, scopes: alice, owner: 'alice' })
		expect(
			await index.authorizeReference({
				hash,
				scopes: bob,
				owner: 'bob',
				alreadyReferenced: new Set([hash]),
			}),
		).toBe(true)
	})

	test("a manifest listing someone else's chunk is refused at push", async () => {
		const index = new BlobAccessIndex(await memoryStore(), null)
		const chunk = enc('alice chunk')
		const chunkHash = await hashBlob(chunk)
		await index.recordPush(chunkHash, chunk, 'alice')
		const crafted = enc(JSON.stringify({ chunkHashes: [chunkHash] }))
		expect(await index.authorizeManifestPush(crafted, bob, 'bob')).toBe(false)
		expect(await index.authorizeManifestPush(crafted, alice, 'alice')).toBe(true)
		// Non-manifest bytes are not judged here.
		expect(await index.authorizeManifestPush(enc('plain bytes'), bob, 'bob')).toBe(true)
	})

	test('an owned chunk is reachable only through a manifest that shares an owner', async () => {
		const store = await memoryStore()
		const chunk = enc('alice chunk')
		const chunkHash = await hashBlob(chunk)
		const honest = enc(JSON.stringify({ chunkHashes: [chunkHash] }))
		const honestHash = await hashBlob(honest)
		const crafted = enc(JSON.stringify({ chunkHashes: [chunkHash], blobHash: 'x' }))
		const craftedHash = await hashBlob(crafted)
		await store.applyRemoteOperation(
			op({
				data: { owner: 'alice', doc: { hash: 'd'.repeat(64), size: 1, manifestHash: honestHash } },
			}),
		)
		await store.applyRemoteOperation(
			op({
				data: { owner: 'bob', doc: { hash: 'e'.repeat(64), size: 1, manifestHash: craftedHash } },
			}),
		)
		const index = new BlobAccessIndex(store, null)
		await index.recordPush(chunkHash, chunk, 'alice')
		await index.recordPush(honestHash, honest, 'alice')
		await store.claimBlobIfUnowned(craftedHash, 'bob')
		index.observeVerifiedBytes(craftedHash, crafted)
		expect(await index.isReferenced(alice, chunkHash)).toBe(true)
		expect(await index.isReferenced(bob, chunkHash)).toBe(false)
	})

	test('a chunked reference is readable by its manifest hash only', () => {
		expect(referencedHashes({ hash: 'h', manifestHash: 'm' })).toEqual(['m'])
		expect(referencedHashes({ hash: 'h' })).toEqual(['h'])
	})

	test('ownership persists in the SQLite store (shared across instances)', async () => {
		const store = createSqliteServerStore({})
		await store.setSchema(schema)
		const a = new BlobAccessIndex(store, null)
		const b = new BlobAccessIndex(store, null)
		const hash = 'f'.repeat(64)
		expect(await a.authorizeReference({ hash, scopes: alice, owner: 'alice' })).toBe(true)
		expect(await b.authorizeReference({ hash, scopes: bob, owner: 'bob' })).toBe(false)
		expect(await store.getBlobOwners([hash])).toEqual(new Map([[hash, ['alice']]]))
	})
})

describe('BlobAccessIndex cache (RT-17)', () => {
	test('concurrent lookups for one scope share a single rebuild', async () => {
		const store = await memoryStore()
		const spy = vi.spyOn(store, 'queryCollection')
		const index = new BlobAccessIndex(store, null)
		await Promise.all(Array.from({ length: 10 }, () => index.isReferenced(alice, 'a'.repeat(64))))
		expect(spy.mock.calls.filter(([c]) => c === 'files')).toHaveLength(1)
	})

	test('invalidating a collection without blob fields keeps the cached set', async () => {
		const store = await memoryStore()
		const spy = vi.spyOn(store, 'queryCollection')
		const index = new BlobAccessIndex(store, null)
		await index.isReferenced(alice, 'a'.repeat(64))
		index.invalidate(['notes'])
		await index.isReferenced(alice, 'a'.repeat(64))
		expect(spy.mock.calls.filter(([c]) => c === 'files')).toHaveLength(1)
		index.invalidate(['files'])
		await index.isReferenced(alice, 'a'.repeat(64))
		expect(spy.mock.calls.filter(([c]) => c === 'files')).toHaveLength(2)
	})

	test('a rebuild invalidated while it runs is not cached', async () => {
		const store = await memoryStore()
		const hash = 'b'.repeat(64)
		const index = new BlobAccessIndex(store, null)
		const pending = index.isReferenced(alice, hash)
		await store.applyRemoteOperation(op({ data: { owner: 'alice', doc: { hash, size: 1 } } }))
		index.invalidate(['files'])
		await pending
		expect(await index.isReferenced(alice, hash)).toBe(true)
	})
})
