/**
 * SYNC-7 repro: one stored operation stamped >5 minutes ahead of the receiver's
 * reference time (e.g. written while the server clock was wrong, or restored from a
 * backup) throws RemoteClockDriftError on every receiver. It is classed retriable, so
 * the delivery batch is never acknowledged and the watermark never advances. Asserts
 * CORRECT behavior: the poisoned op is quarantined/handled and later ops still flow,
 * and the receiver's watermark eventually reaches the server frontier.
 */
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { createTestNetwork } from '../../src/index'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

describe('SYNC-7: far-future remote op blocks the delivery stream', () => {
	test('a single far-future op does not stall delivery of later ops forever', async () => {
		const network = await createTestNetwork(schema, { devices: 2 })
		const [a, b] = network.devices
		if (!a || !b) throw new Error('devices')
		try {
			await b.collection('todos').insert({ title: 'b local' }) // warm B's HLC
			await a.collection('todos').insert({ title: 'seed' })
			await a.sync()
			await b.sync()

			// A legitimately-ingested op as if stamped while the server clock was 1 day fast.
			const seed = network.server.getAllOperations()[0] as Operation
			const future: Operation = {
				...seed,
				id: 'far-future-op',
				type: 'insert',
				recordId: 'future-record',
				data: { title: 'from the future' },
				sequenceNumber: 9_999,
				nodeId: 'server-legacy-node',
				timestamp: {
					wallTime: Date.now() + 24 * 3600_000,
					logical: 0,
					nodeId: 'server-legacy-node',
				},
			}
			await network.server.store.applyRemoteOperation(future)

			const failures: string[] = []
			b.emitter.on('sync:apply-failed', (e) => failures.push(`${e.code}:${String(e.retriable)}`))
			await b.disconnect()
			await b.sync()
			expect(failures).toContain('REMOTE_CLOCK_DRIFT:true')

			// Later ordinary writes from A, in several separate batches.
			const later: string[] = []
			for (let i = 0; i < 3; i++) {
				const row = await a.collection('todos').insert({ title: `later ${i}` })
				later.push(row.id)
				await a.sync()
			}
			await b.disconnect()
			await b.sync()

			const onB = (await b.getState('todos')).map((r) => r.id)
			for (const id of later) expect(onB).toContain(id)
			const status = b.getSyncEngine()?.getStatus()
			expect(status?.deliveryWatermark, 'watermark stuck behind the poisoned op').toBe(
				status?.serverFrontier,
			)
		} finally {
			await network.close()
		}
	}, 30000)
})
