import { type BlobRef, createBlobRef, defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import type { TestDevice, TestNetwork } from '../src/index'
import { createTestNetwork, expectConvergedEventually } from '../src/index'

/**
 * System-level proof that a `blob` field (a content-addressed reference, not the
 * bytes) round-trips through insert and converges under concurrent replacement
 * via last-write-wins through the real store + sync + merge path.
 *
 * The bytes themselves travel out of band (a separate content-addressed channel,
 * built on top of this reference model); this test covers the reference's place
 * in the operation log and merge.
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

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

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

describe('blob field convergence (real sync path)', () => {
	test('a blob reference round-trips through insert and sync', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		const ref = await createBlobRef(bytes('a document'), {
			mimeType: 'text/plain',
			filename: 'doc.txt',
		})
		const created = await deviceA.collection('files').insert({ name: 'doc', attachment: ref })
		await deviceA.sync()
		await deviceB.sync()

		const onB = await deviceB.collection('files').findById(created.id)
		const attachment = onB?.attachment as BlobRef
		expect(attachment.hash).toBe(ref.hash)
		expect(attachment.size).toBe(ref.size)
		expect(attachment.filename).toBe('doc.txt')
	}, 30000)

	test('concurrent replacement of a blob reference converges to one winner', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		const original = await createBlobRef(bytes('v1'))
		const created = await deviceA.collection('files').insert({ name: 'f', attachment: original })
		await deviceA.sync()
		await deviceB.sync()

		// Both replace the attachment with different content while offline.
		const fromA = await createBlobRef(bytes('from-A'))
		const fromB = await createBlobRef(bytes('from-B'))
		await deviceA.collection('files').update(created.id, { attachment: fromA })
		await deviceB.collection('files').update(created.id, { attachment: fromB })

		await deviceA.sync()
		await deviceB.sync()
		await deviceA.sync()
		await deviceB.sync()

		await expectConvergedEventually([deviceA, deviceB], schema)

		// Both devices agree on the same winning reference (deterministic LWW).
		const recA = await deviceA.collection('files').findById(created.id)
		const recB = await deviceB.collection('files').findById(created.id)
		const hashA = (recA?.attachment as BlobRef).hash
		const hashB = (recB?.attachment as BlobRef).hash
		expect(hashA).toBe(hashB)
		expect([fromA.hash, fromB.hash]).toContain(hashA)
	}, 30000)
})
