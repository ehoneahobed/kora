import { isKoraBytesValue } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import { richtextToPlainText } from '@korajs/store'
import { afterEach, describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import type { TestDevice, TestNetwork } from '../src/index'
import {
	createTestNetwork,
	expectConvergedEventually,
	wrapTransportPairWithProtobufWire,
} from '../src/index'

/**
 * These tests exercise binary richtext values (real Yjs Y.Doc updates) flowing
 * between two synced clients THROUGH THE PROTOBUF WIRE FORMAT: every sync
 * message — including the operation batches carrying the richtext op.data — is
 * encoded to protobuf bytes and decoded on the other end (see
 * wrapTransportPairWithProtobufWire), rather than passed as a live object
 * reference. This closes the gap where binary richtext had only been verified
 * for local persistence and in-process apply, never across the real serializer.
 */

const schema = defineSchema({
	version: 1,
	collections: {
		articles: {
			fields: {
				title: t.string(),
				body: t.richtext(),
			},
		},
	},
})

/**
 * A richtext-only collection for the concurrent-merge case. Kept free of other
 * fields so the test isolates the binary-richtext merge path (the merge engine
 * currently re-materializes every schema field on a conflicting update, which
 * would spuriously null unrelated columns — an orthogonal issue outside this
 * gap).
 */
const notesSchema = defineSchema({
	version: 1,
	collections: {
		notes: {
			fields: {
				body: t.richtext().optional(),
			},
		},
	},
})

/** A real Yjs state update, as a richtext controller would persist it. */
function makeYjsUpdate(text: string): Uint8Array {
	const doc = new Y.Doc()
	doc.getText('content').insert(0, text)
	return Y.encodeStateAsUpdate(doc)
}

/** A concurrent edit derived from a shared base state, appending `suffix`. */
function editFromBase(baseState: Uint8Array, suffix: string): Uint8Array {
	const doc = new Y.Doc()
	Y.applyUpdate(doc, baseState)
	const text = doc.getText('content')
	text.insert(text.length, suffix)
	return Y.encodeStateAsUpdate(doc)
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
		if (!d) throw new Error(`Device at index ${i} not found`)
		return d
	})
}

async function findInsertOpId(device: TestDevice, recordId: string): Promise<string> {
	const ops = await device.store.getAllOperations()
	const op = ops.find((o) => o.recordId === recordId && o.type === 'insert')
	if (!op) throw new Error(`No insert op for record ${recordId} on ${device.name}`)
	return op.id
}

describe('Binary richtext through the protobuf wire format', () => {
	test('Uint8Array richtext round-trips A → wire → B with a stable operation id', async () => {
		network = await createTestNetwork(schema, {
			devices: 2,
			wrapTransport: wrapTransportPairWithProtobufWire,
		})
		const [deviceA, deviceB] = devices(0, 1)

		const update = makeYjsUpdate('binary body via protobuf')
		const record = await deviceA.collection('articles').insert({ title: 'a', body: update })

		await deviceA.sync()
		await deviceB.sync()

		// (1) Client B's materialized richtext column decodes to the same Yjs text.
		const foundB = await deviceB.collection('articles').findById(record.id)
		expect(foundB?.body).toBeInstanceOf(Uint8Array)
		expect(richtextToPlainText(foundB?.body as Uint8Array)).toBe('binary body via protobuf')

		// The op that reached B still carries the canonical tagged binary form.
		const opsB = await deviceB.store.getAllOperations()
		const insertB = opsB.find((o) => o.recordId === record.id && o.type === 'insert')
		expect(insertB?.data && isKoraBytesValue(insertB.data.body)).toBe(true)

		// (2) The content-addressed operation id is identical on both ends — proof
		// the protobuf wire round-trip did not perturb the hashed content.
		const idA = await findInsertOpId(deviceA, record.id)
		const idB = await findInsertOpId(deviceB, record.id)
		expect(idB).toBe(idA)
	})

	test('ArrayBuffer richtext round-trips A → wire → B', async () => {
		network = await createTestNetwork(schema, {
			devices: 2,
			wrapTransport: wrapTransportPairWithProtobufWire,
		})
		const [deviceA, deviceB] = devices(0, 1)

		const update = makeYjsUpdate('array buffer body')
		// A genuine ArrayBuffer (not a Uint8Array view) as a richtext value.
		const buffer = update.slice().buffer
		const record = await deviceA.collection('articles').insert({ title: 'ab', body: buffer })

		await deviceA.sync()
		await deviceB.sync()

		const foundB = await deviceB.collection('articles').findById(record.id)
		expect(richtextToPlainText(foundB?.body as Uint8Array)).toBe('array buffer body')

		const idA = await findInsertOpId(deviceA, record.id)
		const idB = await findInsertOpId(deviceB, record.id)
		expect(idB).toBe(idA)
	})

	test('concurrent binary-richtext edits on A and B converge through the wire', async () => {
		network = await createTestNetwork(notesSchema, {
			devices: 2,
			wrapTransport: wrapTransportPairWithProtobufWire,
		})
		const [deviceA, deviceB] = devices(0, 1)

		// Shared starting point, replicated to both clients.
		const baseState = makeYjsUpdate('Base. ')
		const record = await deviceA.collection('notes').insert({ body: baseState })
		await deviceA.sync()
		await deviceB.sync()

		// Each client edits the same richtext field while offline — a true
		// concurrent edit that must be merged by the just-fixed Yjs merge path.
		await deviceA.disconnect()
		await deviceB.disconnect()

		await deviceA
			.collection('notes')
			.update(record.id, { body: editFromBase(baseState, 'From-A. ') })
		await deviceB
			.collection('notes')
			.update(record.id, { body: editFromBase(baseState, 'From-B. ') })

		// Drain both updates to the server, then force each device to pull the
		// other's via a fresh handshake+delta (a reconnect), so convergence does
		// not depend on streaming timing.
		await deviceA.sync() // reconnect A, push A's update
		await deviceB.sync() // reconnect B, push B's update AND pull A's via delta
		await deviceA.disconnect()
		await deviceA.sync() // reconnect A, pull B's update via delta

		await expectConvergedEventually([deviceA, deviceB], notesSchema, { timeoutMs: 8000 })

		// Convergence preserved both concurrent edits (CRDT union), not just LWW —
		// exercising the tagged-binary decode in the Yjs merge path over the wire.
		const foundA = await deviceA.collection('notes').findById(record.id)
		const foundB = await deviceB.collection('notes').findById(record.id)
		const textA = richtextToPlainText(foundA?.body as Uint8Array)
		expect(textA).toContain('Base.')
		expect(textA).toContain('From-A.')
		expect(textA).toContain('From-B.')
		// Both devices materialized byte-identical Yjs state.
		expect(Array.from(foundB?.body as Uint8Array)).toEqual(Array.from(foundA?.body as Uint8Array))
	}, 20000)
})
