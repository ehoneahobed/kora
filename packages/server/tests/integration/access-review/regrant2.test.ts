import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { KoraSyncServer } from '../../../src/server/kora-sync-server'
import { createServerTransportPair } from '../../../src/transport/memory-server-transport'
import { batch, createHarness, makeOp } from '../../repro/rt-fixture'
import { FRESH, auth, items, schema } from './shared'

describe('revoke then re-grant, bob on another instance', () => {
	test('live session on instance B stays stale', async () => {
		const harness = await createHarness(schema, auth)
		const ann = await harness.login('ann', 'ann-node', FRESH)
		ann.send(
			batch([
				makeOp('ann-node', 1, {
					collection: 'documents',
					recordId: 'd1',
					data: { title: 'v1', ownerId: 'ann' },
				}),
			]),
		)
		await harness.settle()
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		const b = new KoraSyncServer({
			store: harness.store,
			auth,
			relayRetransmitIntervalMs: 0,
			deliveryPollIntervalMs: 0,
		})
		const { client, server: transport } = createServerTransportPair()
		const msgs: SyncMessage[] = []
		client.onMessage((m) => msgs.push(m))
		b.handleConnection(transport)
		client.send({
			type: 'handshake',
			messageId: 'h',
			nodeId: 'bob-node',
			versionVector: {},
			schemaVersion: 1,
			authToken: 'bob',
			...FRESH,
		} as SyncMessage)
		await vi.waitFor(() => expect(msgs.some((m) => m.type === 'handshake-response')).toBe(true))
		// Deterministic barriers: each server has handled everything sent to it so far.
		await b.whenIdle()
		expect(items(msgs).map((i) => i.key)).toContain('documents/d1')
		const before = msgs.length
		await harness.server.access.revoke({ userId: 'bob', group: ['documents', 'd1'] })
		ann.send(
			batch([
				makeOp('ann-node', 2, {
					type: 'update',
					collection: 'documents',
					recordId: 'd1',
					data: { title: 'v2-while-out' },
					previousData: { title: 'v1' },
				}),
			]),
		)
		await harness.settle()
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		await b.pollDeliveryLog()
		await b.whenIdle()
		const got = items(msgs.slice(before), msgs.slice(0, before))
		const hasV2 = got.some((i) => JSON.stringify(i.data ?? '').includes('v2-while-out'))
		const retracted = got.some((i) => i.kind === 'retract' && i.key === 'documents/d1')
		expect(hasV2 || retracted).toBe(true)
	})
})
