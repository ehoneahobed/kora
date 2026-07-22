import { type BlobRef, createBlobRef, defineSchema, t } from '@korajs/core'
import { collectBlobGarbage } from '@korajs/store'
import { afterEach, describe, expect, test } from 'vitest'
import type { TestDevice, TestNetwork } from '../src/index'
import { createTestNetwork } from '../src/index'

/**
 * End-to-end proof that a blob's BYTES (not just its reference) transfer between
 * two devices over the LIVE sync connection.
 *
 * The record carrying the `BlobRef` syncs through the normal operation path
 * (deviceA → server → deviceB). The bytes then travel out of band over the same
 * WebSocket: deviceB pulls the missing chunks by hash, the server relays each
 * request to deviceA (which holds them) and routes the answer back, and deviceB
 * reassembles the blob with an integrity check against the manifest's blob hash.
 *
 * The server in this harness has no blob storage and no `resolveBlobChunk`, so it
 * is a pure relay: it never sees or stores blob bytes. This is the peer-to-peer
 * blob transfer path a real deployment uses by default.
 */
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

/** Deterministic pseudo-random bytes (no timing/entropy dependence). */
function makeBytes(n: number, seed: number): Uint8Array {
	const out = new Uint8Array(n)
	let x = seed >>> 0
	for (let i = 0; i < n; i++) {
		x = (x * 1664525 + 1013904223) >>> 0
		out[i] = (x >>> 24) & 0xff
	}
	return out
}

/** Poll a predicate until true or a bounded number of ticks elapse. */
async function waitFor(predicate: () => Promise<boolean>, ticks = 50): Promise<void> {
	for (let i = 0; i < ticks; i++) {
		if (await predicate()) {
			return
		}
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error('waitFor: condition not met within the allotted ticks')
}

let network: TestNetwork | null = null

afterEach(async () => {
	if (network) {
		await network.close()
		network = null
	}
})

function devices(...indices: number[]): TestDevice[] {
	return indices.map((i) => {
		const d = network?.devices[i]
		if (!d) {
			throw new Error(`Device at index ${i} not found`)
		}
		return d
	})
}

describe('blob bytes convergence (out-of-band transfer over the live sync connection)', () => {
	test('deviceB pulls a blob it does not have from deviceA through the server relay', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		// deviceA authors a multi-chunk blob and stages its chunks locally so it can
		// serve them. The record only carries the reference.
		const original = makeBytes(2000, 11)
		const ref = await createBlobRef(original, {
			mimeType: 'application/octet-stream',
			filename: 'blob.bin',
		})
		const manifest = await deviceA.stageBlob(original, { chunkSize: 256 })
		expect(manifest.blobHash).toBe(ref.hash) // reference and bytes agree on identity
		expect(manifest.chunkHashes.length).toBeGreaterThan(1) // genuinely multi-chunk

		const created = await deviceA.collection('files').insert({ name: 'doc', attachment: ref })

		// The reference syncs through the normal operation path.
		await deviceA.sync()
		await deviceB.sync()
		const onB = await deviceB.collection('files').findById(created.id)
		expect((onB?.attachment as BlobRef).hash).toBe(ref.hash)

		// deviceB does not hold the bytes yet.
		expect(await deviceB.getBlobBytes(ref.hash)).toBeNull()

		// Pull the bytes out of band over the same connection.
		const result = await deviceB.pullBlob(manifest)
		expect(result.ref.hash).toBe(ref.hash)
		expect(result.chunksFetched).toBe(manifest.chunkHashes.length)
		expect(result.chunksSkipped).toBe(0)

		// deviceB now has the exact original bytes, integrity-verified.
		expect(await deviceB.getBlobBytes(ref.hash)).toEqual(original)
	}, 30000)

	test('a resumed pull fetches only the chunks deviceB is missing', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		const original = makeBytes(2000, 22)
		const manifest = await deviceA.stageBlob(original, { chunkSize: 256 })
		await deviceA.sync()
		await deviceB.sync()

		// Simulate an interrupted prior transfer: deviceB already holds the first
		// two chunks. Stage the same bytes on B to obtain those chunk bytes, then
		// keep only the first two by pulling with a truncated manifest is awkward;
		// instead prime B's store directly with the first two chunk hashes.
		const priming = await deviceB.stageBlob(original, { chunkSize: 256 })
		// deviceB.stageBlob put ALL chunks into B's store. Remove all but the first
		// two so the pull genuinely has work to do, proving skip vs fetch accounting.
		for (const hash of priming.chunkHashes.slice(2)) {
			await deviceB.blobStore.delete(hash)
		}
		await deviceB.blobStore.delete(manifest.blobHash)

		const result = await deviceB.pullBlob(manifest)
		expect(result.chunksSkipped).toBe(2)
		expect(result.chunksFetched).toBe(manifest.chunkHashes.length - 2)
		expect(await deviceB.getBlobBytes(manifest.blobHash)).toEqual(original)
	}, 30000)

	test('deviceB pulls a blob knowing only the reference from the synced record', async () => {
		// The end-to-end "zero-effort" path: B never receives a manifest out of band.
		// It reads the BlobRef from the synced record and pulls the bytes from that
		// alone — the manifest is resolved by ref.manifestHash over the connection.
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		const original = makeBytes(2600, 55)
		const { ref } = await deviceA.putBlob(original, { chunkSize: 256, filename: 'ref-only.bin' })
		expect(ref.manifestHash).toBeDefined() // reference carries its manifest pointer

		const created = await deviceA.collection('files').insert({ name: 'doc', attachment: ref })
		await deviceA.sync()
		await deviceB.sync()

		// B has only what the record carried: the reference.
		const onB = await deviceB.collection('files').findById(created.id)
		const refOnB = onB?.attachment as BlobRef
		expect(refOnB.manifestHash).toBe(ref.manifestHash)
		expect(await deviceB.getBlobBytes(refOnB.hash)).toBeNull()

		const result = await deviceB.pullBlobByRef(refOnB)
		expect(result.ref.hash).toBe(ref.hash)
		expect(await deviceB.getBlobBytes(refOnB.hash)).toEqual(original)
	}, 30000)

	test('a blob stays available from the server after the authoring device goes offline', async () => {
		// The central-availability guarantee: A authors a blob, it auto-uploads to
		// the server as the record syncs, A disconnects, and B still pulls the bytes
		// from the server — no peer holding them.
		network = await createTestNetwork(schema, { devices: 2, blobStorage: true })
		const [deviceA, deviceB] = devices(0, 1)
		const serverBlobStore = network.server.blobStore
		if (!serverBlobStore) {
			throw new Error('expected server blob storage to be enabled')
		}

		const original = makeBytes(2800, 77)
		const { ref } = await deviceA.putBlob(original, { chunkSize: 256, filename: 'central.bin' })
		const manifestHash = ref.manifestHash as string
		const created = await deviceA.collection('files').insert({ name: 'doc', attachment: ref })

		// Syncing the record also auto-uploads the blob's bytes to the server.
		await deviceA.sync()
		await waitFor(async () => serverBlobStore.has(manifestHash))
		for (const chunkHash of (await deviceA.putBlob(original, { chunkSize: 256 })).manifest
			.chunkHashes) {
			await waitFor(async () => serverBlobStore.has(chunkHash))
		}

		// B learns the reference, then the author goes offline entirely.
		await deviceB.sync()
		const onB = await deviceB.collection('files').findById(created.id)
		expect((onB?.attachment as BlobRef).hash).toBe(ref.hash)
		await deviceA.disconnect()

		// B pulls the bytes purely from the server.
		const result = await deviceB.pullBlobByRef(onB?.attachment as BlobRef)
		expect(result.ref.hash).toBe(ref.hash)
		expect(await deviceB.getBlobBytes(ref.hash)).toEqual(original)
	}, 30000)

	test('server GC reclaims a central blob after its record is deleted', async () => {
		network = await createTestNetwork(schema, { devices: 2, blobStorage: true })
		const [deviceA] = devices(0)
		const serverBlobStore = network.server.blobStore
		if (!serverBlobStore) {
			throw new Error('expected server blob storage')
		}

		const { ref } = await deviceA.putBlob(makeBytes(2400, 88), { chunkSize: 256 })
		const manifestHash = ref.manifestHash as string
		const record = await deviceA.collection('files').insert({ name: 'doc', attachment: ref })
		await deviceA.sync()
		await waitFor(async () => serverBlobStore.has(manifestHash))

		// While referenced, the server's live set includes the blob and GC keeps it.
		const liveBefore = await network.server.getLiveBlobRefs()
		expect(liveBefore.some((r) => r.hash === ref.hash)).toBe(true)
		const keep = await collectBlobGarbage(serverBlobStore, liveBefore)
		expect(keep.collected).toBe(0)
		expect(await serverBlobStore.has(manifestHash)).toBe(true)

		// Delete the record and sync; the server's live set no longer includes it.
		await deviceA.collection('files').delete(record.id)
		await deviceA.sync()
		await waitFor(async () => (await network.server.getLiveBlobRefs()).length === 0)

		const swept = await collectBlobGarbage(serverBlobStore, await network.server.getLiveBlobRefs())
		expect(swept.collected).toBeGreaterThan(0)
		expect(await serverBlobStore.has(manifestHash)).toBe(false)
	}, 30000)

	test('two blobs from different authors each transfer to the other device', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		const bytesA = makeBytes(1500, 33)
		const bytesB = makeBytes(1700, 44)
		const refA = await createBlobRef(bytesA, { filename: 'a.bin' })
		const refB = await createBlobRef(bytesB, { filename: 'b.bin' })
		const manifestA = await deviceA.stageBlob(bytesA, { chunkSize: 256 })
		const manifestB = await deviceB.stageBlob(bytesB, { chunkSize: 256 })

		await deviceA.collection('files').insert({ name: 'from-a', attachment: refA })
		await deviceB.collection('files').insert({ name: 'from-b', attachment: refB })
		await deviceA.sync()
		await deviceB.sync()
		await deviceA.sync()

		// Each device pulls the blob authored by the other.
		await deviceB.pullBlob(manifestA)
		await deviceA.pullBlob(manifestB)

		expect(await deviceB.getBlobBytes(refA.hash)).toEqual(bytesA)
		expect(await deviceA.getBlobBytes(refB.hash)).toEqual(bytesB)
	}, 30000)
})
