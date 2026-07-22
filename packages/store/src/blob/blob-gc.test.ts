import type { BlobRef } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { collectBlobGarbage, extractBlobRefs } from './blob-gc'
import { putBlobForTransfer } from './blob-manifest-transfer'
import { MemoryBlobStore } from './content-addressed-blob-store'

function makeBytes(n: number, seed: number): Uint8Array {
	const out = new Uint8Array(n)
	let x = seed >>> 0
	for (let i = 0; i < n; i++) {
		x = (x * 1664525 + 1013904223) >>> 0
		out[i] = (x >>> 24) & 0xff
	}
	return out
}

describe('extractBlobRefs', () => {
	test("finds blob refs among a record's field values", async () => {
		const store = new MemoryBlobStore()
		const { ref } = await putBlobForTransfer(store, makeBytes(300, 1))
		const record = { id: 'r1', title: 'hi', attachment: ref, count: 3, missing: null }
		expect(extractBlobRefs(record)).toEqual([ref])
	})

	test('returns nothing for a record with no blob fields', () => {
		expect(extractBlobRefs({ id: 'r1', title: 'plain' })).toEqual([])
	})
})

describe('collectBlobGarbage', () => {
	test('collects a blob no live reference points to (blob, manifest, and chunks)', async () => {
		const store = new MemoryBlobStore()
		const { ref } = await putBlobForTransfer(store, makeBytes(2000, 2), { chunkSize: 256 })
		const before = await store.size()
		expect(before).toBeGreaterThan(2) // full blob + manifest + several chunks

		// No live refs → everything is garbage.
		const result = await collectBlobGarbage(store, [])
		expect(result.scanned).toBe(before)
		expect(result.live).toBe(0)
		expect(result.collected).toBe(before)
		expect(await store.size()).toBe(0)
	})

	test('keeps a blob that is still referenced', async () => {
		const store = new MemoryBlobStore()
		const { ref } = await putBlobForTransfer(store, makeBytes(2000, 3), { chunkSize: 256 })
		const before = await store.size()

		const result = await collectBlobGarbage(store, [ref])
		expect(result.collected).toBe(0)
		expect(await store.size()).toBe(before)
		// The blob is still fully intact and retrievable.
		expect(await store.get(ref.hash)).not.toBeNull()
	})

	test('deduplication-safe: a chunk shared by a surviving blob is not collected', async () => {
		const store = new MemoryBlobStore()
		// Two blobs that share an identical leading chunk (same 256 bytes) but differ
		// after, so they share at least one chunk hash.
		const shared = makeBytes(256, 9)
		const a = new Uint8Array(512)
		a.set(shared, 0)
		a.set(makeBytes(256, 10), 256)
		const b = new Uint8Array(512)
		b.set(shared, 0)
		b.set(makeBytes(256, 11), 256)

		const { ref: refA, manifest: manA } = await putBlobForTransfer(store, a, { chunkSize: 256 })
		const { ref: refB, manifest: manB } = await putBlobForTransfer(store, b, { chunkSize: 256 })
		const sharedChunk = manA.chunkHashes[0]
		expect(manB.chunkHashes[0]).toBe(sharedChunk) // genuinely shared

		// Collect with only B live: A's unique bytes go, but the shared chunk stays.
		await collectBlobGarbage(store, [refB])

		expect(await store.has(sharedChunk as string)).toBe(true) // shared chunk survived
		expect(await store.get(refB.hash)).not.toBeNull() // B intact
		expect(await store.has(refA.hash)).toBe(false) // A's full blob collected
		expect(await store.has(manA.chunkHashes[1] as string)).toBe(false) // A's unique chunk collected
	})

	test('dryRun reports what would be collected without deleting', async () => {
		const store = new MemoryBlobStore()
		await putBlobForTransfer(store, makeBytes(1000, 4), { chunkSize: 256 })
		const before = await store.size()

		const result = await collectBlobGarbage(store, [], { dryRun: true })
		expect(result.collected).toBe(before)
		expect(result.collectedHashes).toHaveLength(before)
		expect(await store.size()).toBe(before) // nothing actually deleted
	})

	test('is idempotent: a second sweep with the same live set collects nothing', async () => {
		const store = new MemoryBlobStore()
		const { ref } = await putBlobForTransfer(store, makeBytes(1500, 5), { chunkSize: 256 })
		const orphan: BlobRef = (await putBlobForTransfer(store, makeBytes(800, 6), { chunkSize: 256 }))
			.ref
		void orphan

		const first = await collectBlobGarbage(store, [ref])
		expect(first.collected).toBeGreaterThan(0)
		const second = await collectBlobGarbage(store, [ref])
		expect(second.collected).toBe(0)
	})
})
