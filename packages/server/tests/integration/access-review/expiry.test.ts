import { afterEach, describe, expect, test } from 'vitest'
import { batch, createHarness, makeOp } from '../../repro/rt-fixture'
import { FRESH, auth, controlClock, items, schema } from './shared'

describe('expiry', () => {
	// Deterministic: expiry is reached by advancing the clock, and each step waits for the
	// server to finish what it was sent (never a fixed delay).
	let clock: ReturnType<typeof controlClock> | null = null
	afterEach(() => {
		clock?.restore()
		clock = null
	})
	test('an expired membership: edits after expiry leak as entries, and the sweep never retracts', async () => {
		clock = controlClock()
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
		await harness.server.access.grant({
			userId: 'bob',
			group: ['documents', 'd1'],
			role: 'view',
			expiresAt: Date.now() + 60_000,
		})
		const bob = await harness.login('bob', 'bob-node', FRESH)
		await harness.settle()
		expect(items(bob.messages).map((i) => i.key)).toContain('documents/d1')
		clock?.advance(120_000) // membership expired, not swept yet
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
		await harness.settle()
		const after = items(bob.messages.slice(before), bob.messages.slice(0, before))
		const leaked = after.some((i) => JSON.stringify(i.data ?? '').includes('SECRET-after-expiry'))
		// Sweep: the expiry gets a log position. Bob must now be told to drop d1.
		const swept = await harness.server.access.sweepExpired()
		await harness.settle()
		const all = items(bob.messages)
		expect({
			leaked,
			retracted: all.some((i) => i.kind === 'retract' && i.key === 'documents/d1'),
		}).toEqual({ leaked: false, retracted: true })
	})

	test('expired + swept while offline: reconnect never retracts', async () => {
		clock = controlClock()
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
		await harness.server.access.grant({
			userId: 'bob',
			group: ['documents', 'd1'],
			role: 'view',
			expiresAt: Date.now() + 60_000,
		})
		const first = await harness.login('bob', 'bob-node', FRESH)
		await harness.settle()
		const { watermarkOf } = await import('./shared')
		const w = watermarkOf(first.messages)
		const accepted = first.messages.find((m) => m.type === 'handshake-response') as {
			acceptedDownlinkScopes?: Record<string, Record<string, unknown>>
		}
		await first.client.disconnect()
		await harness.settle()
		clock?.advance(120_000)
		await harness.server.access.sweepExpired()
		const { scopeViewKey } = await import('@korajs/sync/internal')
		const second = await harness.login('bob', 'bob-node', {
			supportsScopeDisjunction: true,
			lastDeliverySequence: w,
			acceptedScopeKey: scopeViewKey(accepted.acceptedDownlinkScopes),
			acceptedScopeWatermark: w,
		} as never)
		await harness.settle()
		const got = items(second.messages, first.messages)
		expect(got.some((i) => i.kind === 'retract' && i.key === 'documents/d1')).toBe(true)
	})
})
