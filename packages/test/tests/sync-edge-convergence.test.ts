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
 * Edge scenarios the main convergence suites don't cover: concurrent
 * delete-vs-delete, a richtext CRDT edit racing a scalar edit on the SAME
 * record, an offline device reconnecting with queued conflicting edits, and a
 * kitchen sink of tricky values (unicode, floats, null-ing optionals, empty
 * arrays) with same-field conflicts, run through the REAL protobuf wire
 * serializer rather than in-process object passing.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		docs: {
			fields: {
				title: t.string(),
				body: t.richtext().optional(),
				priority: t.number().default(0),
			},
		},
	},
})

const kitchenSchema = defineSchema({
	version: 1,
	collections: {
		samples: {
			fields: {
				label: t.string(),
				note: t.string().optional(),
				score: t.number().default(0),
				tags: t.array(t.string()).default([]),
				active: t.boolean().default(true),
			},
		},
	},
})

function makeYjsUpdate(text: string): Uint8Array {
	const doc = new Y.Doc()
	doc.getText('content').insert(0, text)
	return Y.encodeStateAsUpdate(doc)
}

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
		if (!d) {
			throw new Error(`Device at index ${i} not found`)
		}
		return d
	})
}

async function fullExchange(all: TestDevice[], rounds = 3): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		for (const device of all) {
			await device.sync()
		}
	}
}

describe('Sync edge convergence', () => {
	test('concurrent delete on BOTH devices converges to one tombstone', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		const created = await deviceA.collection('docs').insert({ title: 'doomed', priority: 1 })
		await fullExchange([deviceA, deviceB], 2)

		// TRUE concurrency: both offline, both delete, then both reconnect.
		await deviceA.disconnect()
		await deviceB.disconnect()
		await deviceA.collection('docs').delete(created.id)
		await deviceB.collection('docs').delete(created.id)
		await deviceA.reconnect()
		await deviceB.reconnect()

		await fullExchange([deviceA, deviceB])
		await expectConvergedEventually([deviceA, deviceB], schema)

		for (const device of [deviceA, deviceB]) {
			const rec = await device.collection('docs').findById(created.id)
			expect(rec).toBeNull()
		}
	}, 30000)

	test('richtext CRDT edit and scalar edit on the SAME record both survive', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		const base = makeYjsUpdate('shared text')
		const created = await deviceA
			.collection('docs')
			.insert({ title: 'mixed', body: base, priority: 1 })
		await fullExchange([deviceA, deviceB], 2)

		// Concurrent: A extends the richtext body, B bumps the scalar priority.
		await deviceA.collection('docs').update(created.id, { body: editFromBase(base, ' +A') })
		await deviceB.collection('docs').update(created.id, { priority: 9 })

		await fullExchange([deviceA, deviceB])
		await expectConvergedEventually([deviceA, deviceB], schema)

		for (const device of [deviceA, deviceB]) {
			const rec = await device.collection('docs').findById(created.id)
			expect(richtextToPlainText(rec?.body as Uint8Array)).toBe('shared text +A')
			expect(rec?.priority).toBe(9) // scalar edit not clobbered by the CRDT merge
			expect(rec?.title).toBe('mixed') // untouched field preserved
		}
	}, 30000)

	test('offline device with queued conflicting edits reconverges on reconnect', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [deviceA, deviceB] = devices(0, 1)

		const created = await deviceA.collection('docs').insert({ title: 'v0', priority: 0 })
		await fullExchange([deviceA, deviceB], 2)

		// A goes fully offline and queues several edits, including to the same
		// field B is editing live.
		await deviceA.disconnect()
		await deviceA.collection('docs').update(created.id, { title: 'offline-1' })
		await deviceA.collection('docs').update(created.id, { priority: 5 })
		await deviceA.collection('docs').update(created.id, { title: 'offline-2' })

		// B keeps editing while connected.
		await deviceB.collection('docs').update(created.id, { title: 'online-1' })
		await deviceB.sync()

		// A reconnects; queued operations flush and both sides converge.
		await deviceA.reconnect()
		await fullExchange([deviceA, deviceB])
		await expectConvergedEventually([deviceA, deviceB], schema)

		const a = await deviceA.collection('docs').findById(created.id)
		const b = await deviceB.collection('docs').findById(created.id)
		expect(a?.title).toBe(b?.title)
		expect(['offline-2', 'online-1']).toContain(a?.title)
		expect(a?.priority).toBe(5) // only A touched priority — must survive either way
	}, 30000)

	test('unicode, floats, nulled optionals, and empty arrays converge through the protobuf wire', async () => {
		network = await createTestNetwork(kitchenSchema, {
			devices: 2,
			wrapTransport: wrapTransportPairWithProtobufWire,
		})
		const [deviceA, deviceB] = devices(0, 1)

		const created = await deviceA.collection('samples').insert({
			label: 'naïve café ☕️ — 中文 · العربية',
			note: 'to be cleared',
			score: -273.15,
			tags: ['ünïcødé', '🎯'],
			active: true,
		})
		await fullExchange([deviceA, deviceB], 2)

		const onB = await deviceB.collection('samples').findById(created.id)
		expect(onB?.label).toBe('naïve café ☕️ — 中文 · العربية')
		expect(onB?.score).toBe(-273.15)
		expect(onB?.tags).toEqual(['ünïcødé', '🎯'])

		// Concurrent tricky edits: A nulls the optional + empties the array,
		// B contends on label with more unicode and flips the boolean.
		await deviceA.collection('samples').update(created.id, { note: null, tags: [] })
		await deviceB
			.collection('samples')
			.update(created.id, { label: '🚀 v2 — Ω≈ç√∫', active: false })

		await fullExchange([deviceA, deviceB])
		await expectConvergedEventually([deviceA, deviceB], kitchenSchema)

		for (const device of [deviceA, deviceB]) {
			const rec = await device.collection('samples').findById(created.id)
			expect(rec?.label).toBe('🚀 v2 — Ω≈ç√∫')
			expect(rec?.note).toBeNull()
			expect(rec?.active).toBe(false)
			expect(rec?.score).toBe(-273.15)
			// Add-wins keeps 'base' removals one-sided: A emptied the array while B
			// didn't touch it, so A's removal wins (no concurrent add).
			expect(rec?.tags).toEqual([])
		}
	}, 30000)
})
