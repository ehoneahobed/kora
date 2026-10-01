import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import type { TestNetwork } from '../../src/index'
import { createTestNetwork } from '../../src/index'

/**
 * CORE-1 (receive path): op ids are never verified on any receive path
 * (server handleOperationBatch, client SyncEngine inbound, store apply).
 * An op whose id is not the content hash must be rejected, not stored,
 * relayed and materialized.
 */
const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string() } } },
})

let network: TestNetwork | null = null
afterEach(async () => {
	await network?.close()
	network = null
})

describe('CORE-1 receive paths verify content-addressed ids', () => {
	test('server and peers reject an op whose id is not its content hash', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [a, b] = network.devices as [(typeof network.devices)[0], (typeof network.devices)[0]]
		const rec = await a.collection('notes').insert({ title: 'original' })
		await a.sync()
		await b.sync()

		// B forges an update with an arbitrary (non-hash) id and pushes it over the real wire.
		const legit = (await b.store.getOperationsForRecord('notes', rec.id))[0] as Operation
		const forged: Operation = {
			...legit,
			id: 'f'.repeat(64),
			type: 'update',
			nodeId: b.getNodeId(),
			data: { title: 'forged' },
			previousData: { title: 'original' },
			timestamp: { wallTime: Date.now() + 1000, logical: 0, nodeId: b.getNodeId() },
			sequenceNumber: 999,
			causalDeps: [],
		}
		await b.getSyncEngine()?.pushOperation(forged)
		await b.sync()
		await a.sync()

		const serverIds = network.server.getAllOperations().map((o) => o.id)
		expect.soft(serverIds).not.toContain('f'.repeat(64))
		expect.soft((await a.collection('notes').findById(rec.id))?.title).toBe('original')
	}, 30000)
})
