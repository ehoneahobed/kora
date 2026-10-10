import { scopeViewKey } from '@korajs/sync/internal'
import { describe, expect, test } from 'vitest'
import { batch, createHarness, makeOp, tick } from '../../repro/rt-fixture'
import { FRESH, auth, items, schema, watermarkOf } from './shared'

async function base() {
	const harness = await createHarness(schema, auth, { experimentalAccessRules: true })
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
	await tick(150)
	await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
	return { harness, ann }
}

describe('revoke then re-grant', () => {
	test('offline: the edit made while bob was out is never delivered (stale forever)', async () => {
		const { harness, ann } = await base()
		const first = await harness.login('bob', 'bob-node', FRESH)
		await tick(100)
		const w = watermarkOf(first.messages)
		const accepted = first.messages.find((m) => m.type === 'handshake-response') as {
			acceptedDownlinkScopes?: Record<string, Record<string, unknown>>
		}
		await first.client.disconnect()
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
		await tick(150)
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		const second = await harness.login('bob', 'bob-node', {
			supportsScopeDisjunction: true,
			lastDeliverySequence: w,
			acceptedScopeKey: scopeViewKey(accepted.acceptedDownlinkScopes),
			acceptedScopeWatermark: w,
		} as never)
		await tick(200)
		const got = items(second.messages)
		const hasV2 = got.some((i) => JSON.stringify(i.data ?? '').includes('v2-while-out'))
		const retracted = got.some((i) => i.kind === 'retract' && i.key === 'documents/d1')
		// Either it re-sends the current state, or it retracts; silently keeping v1 is divergence.
		expect(hasV2 || retracted).toBe(true)
	})

	test('live: revoke+edit+regrant committed before bob streams them', async () => {
		const { harness, ann } = await base()
		const bob = await harness.login('bob', 'bob-node', FRESH)
		await tick(100)
		const before = bob.messages.length
		const edit = makeOp('ann-node', 2, {
			type: 'update',
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'v2-while-out' },
			previousData: { title: 'v1' },
		})
		await harness.server.access.revoke({ userId: 'bob', group: ['documents', 'd1'] })
		ann.send(batch([edit]))
		await tick(5)
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		await tick(300)
		const got = items(bob.messages.slice(before))
		const hasV2 = got.some((i) => JSON.stringify(i.data ?? '').includes('v2-while-out'))
		const retracted = got.some((i) => i.kind === 'retract' && i.key === 'documents/d1')
		expect(hasV2 || retracted).toBe(true)
	})
})
