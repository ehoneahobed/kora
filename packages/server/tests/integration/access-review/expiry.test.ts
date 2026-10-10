import { describe, expect, test, vi } from 'vitest'
import { batch, createHarness, makeOp, tick } from '../../repro/rt-fixture'
import { FRESH, auth, items, schema } from './shared'

describe('expiry', () => {
	test('an expired membership: edits after expiry leak as entries, and the sweep never retracts', async () => {
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
		await harness.server.access.grant({
			userId: 'bob',
			group: ['documents', 'd1'],
			role: 'view',
			expiresAt: Date.now() + 400,
		})
		const bob = await harness.login('bob', 'bob-node', FRESH)
		await tick(100)
		expect(items(bob.messages).map((i) => i.key)).toContain('documents/d1')
		await tick(500) // membership expired, not swept yet
		const before = bob.messages.length
		ann.send(
			batch([
				makeOp('ann-node', 2, {
					type: 'update',
					collection: 'documents',
					recordId: 'd1',
					data: { title: 'SECRET-after-expiry' },
					previousData: { title: 'v1' },
				}),
			]),
		)
		await tick(300)
		const after = items(bob.messages.slice(before), bob.messages.slice(0, before))
		const leaked = after.some((i) => JSON.stringify(i.data ?? '').includes('SECRET-after-expiry'))
		// Sweep: the expiry gets a log position. Bob must now be told to drop d1.
		const swept = await harness.server.access.sweepExpired()
		await tick(300)
		const all = items(bob.messages)
		expect({
			leaked,
			retracted: all.some((i) => i.kind === 'retract' && i.key === 'documents/d1'),
		}).toEqual({ leaked: false, retracted: true })
	})

	test('expired + swept while offline: reconnect never retracts', async () => {
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
		await harness.server.access.grant({
			userId: 'bob',
			group: ['documents', 'd1'],
			role: 'view',
			expiresAt: Date.now() + 400,
		})
		const first = await harness.login('bob', 'bob-node', FRESH)
		await tick(100)
		const { watermarkOf } = await import('./shared')
		const w = watermarkOf(first.messages)
		const accepted = first.messages.find((m) => m.type === 'handshake-response') as {
			acceptedDownlinkScopes?: Record<string, Record<string, unknown>>
		}
		await first.client.disconnect()
		await tick(500)
		await harness.server.access.sweepExpired()
		const { scopeViewKey } = await import('@korajs/sync/internal')
		const second = await harness.login('bob', 'bob-node', {
			supportsScopeDisjunction: true,
			lastDeliverySequence: w,
			acceptedScopeKey: scopeViewKey(accepted.acceptedDownlinkScopes),
			acceptedScopeWatermark: w,
		} as never)
		await tick(200)
		const got = items(second.messages, first.messages)
		expect(got.some((i) => i.kind === 'retract' && i.key === 'documents/d1')).toBe(true)
	})
})
