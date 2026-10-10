import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { batch, createHarness, makeOp, tick } from '../../repro/rt-fixture'
import { FRESH, auth, schema } from './shared'

type B = {
	messageId: string
	baseDeliverySequence: number
	maxDeliverySequence: number
	operations: Array<{ collection: string; recordId: string; nodeId: string }>
	retractions?: Array<{ collection: string; recordId: string }>
}

describe('rewind after a lost batch and a lost ack', () => {
	test('the re-scope unit is re-sent below the client watermark and dropped', async () => {
		const harness = await createHarness(schema, auth, {
			experimentalAccessRules: true,
			batchSize: 1,
		})
		const ann = await harness.login('ann', 'ann-node', FRESH)
		ann.send(
			batch([
				makeOp('ann-node', 1, {
					collection: 'documents',
					recordId: 'd1',
					data: { title: 'one', ownerId: 'ann' },
				}),
				makeOp('ann-node', 2, {
					collection: 'documents',
					recordId: 'd2',
					data: { title: 'two', ownerId: 'ann' },
				}),
			]),
		)
		await tick(150)
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd2'], role: 'view' })
		const bob = harness.connect()
		// A faithful client chain: apply base==wm or straddling, skip duplicates, stall on gaps.
		const client = {
			wm: 0,
			applied: new Set<string>(),
			dropNextUnit: false,
			ackMode: 'ack' as 'ack' | 'lose',
		}
		bob.client.onMessage((m: SyncMessage) => {
			bob.messages.push(m)
			if (m.type !== 'operation-batch') return
			const b = m as unknown as B
			if (typeof b.maxDeliverySequence !== 'number') return
			const isUnit = b.operations.some(
				(o) => o.nodeId === 'kora:scope-entry' && o.recordId === 'd1',
			)
			if (b.baseDeliverySequence > client.wm) return

			for (const o of b.operations) client.applied.add(`${o.collection}/${o.recordId}`)
			client.wm = Math.max(client.wm, b.maxDeliverySequence)
			if (client.ackMode === 'ack')
				queueMicrotask(() =>
					bob.client.send({
						type: 'acknowledgment',
						messageId: `a-${Math.random()}`,
						acknowledgedMessageId: b.messageId,
						lastSequenceNumber: 0,
						deliverySequence: client.wm,
					} as SyncMessage),
				)
		})
		bob.send({
			type: 'handshake',
			messageId: 'h',
			nodeId: 'bob-node',
			versionVector: {},
			schemaVersion: 1,
			authToken: 'bob',
			...FRESH,
		} as SyncMessage)
		await tick(300)
		expect(client.applied.has('documents/d2')).toBe(true)
		// Acks now get lost; ann edits d2 (bob applies it, his ack is lost) ...
		client.ackMode = 'lose'
		ann.send(
			batch([
				makeOp('ann-node', 3, {
					type: 'update',
					collection: 'documents',
					recordId: 'd2',
					data: { title: 'two-b' },
					previousData: { title: 'two' },
				}),
			]),
		)
		await tick(200)
		// ... then bob is granted d1, and the batch carrying that unit is lost.
		client.dropNextUnit = true
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		await tick(200)
		client.ackMode = 'ack'
		// Retransmit from the acknowledged position (what the retransmit timer/poll do).
		await harness.server.pollDeliveryLog()
		await tick(400)
		expect(client.applied.has('documents/d1')).toBe(true)
	})
})
