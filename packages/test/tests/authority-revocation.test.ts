/**
 * RT-81 end to end: an operator revokes an explicit authority with the server store's
 * `revokedAuthoritativeNodeIds`. The handshake advertises the revocation; a device that
 * held the id in its authority union drops it for good and re-folds, so its
 * `merge('server-authoritative')` values agree with the server's again.
 */
import { HybridLogicalClock, createOperation, defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { MemoryServerStore } from '@korajs/server'
import { describe, expect, test } from 'vitest'
import { type TestDevice, createTestNetwork } from '../src/index'

const schema = defineSchema({
	version: 1,
	collections: {
		items: { fields: { title: t.string(), status: t.string().merge('server-authoritative') } },
	},
}) as unknown as SchemaDefinition

describe('explicit authority revocation (RT-81)', () => {
	test('a device drops a revoked authority at handshake and converges with the server', async () => {
		const serverStore = new MemoryServerStore(undefined, {
			revokedAuthoritativeNodeIds: ['admin-svc'],
		})
		const network = await createTestNetwork(schema, { devices: 1, serverStore })
		try {
			const [device] = network.devices as [TestDevice]
			// The device learned 'admin-svc' from an earlier deployment that listed it.
			await device.store.setAuthoritativeNodeIds(['admin-svc'])
			const admin = await createOperation(
				{
					nodeId: 'admin-svc',
					type: 'insert',
					collection: 'items',
					recordId: 'i1',
					data: { title: 't', status: 'approved' },
					previousData: null,
					sequenceNumber: 1,
					causalDeps: [],
					schemaVersion: 1,
				},
				new HybridLogicalClock('admin-svc', { now: () => 1_000 }),
			)
			await serverStore.applyRemoteOperation(admin)
			await device.store.applyRemoteOperation(admin)
			await device.collection('items').update('i1', { status: 'client' })
			// Still authoritative on the device (it has not heard of the revocation yet).
			expect((await device.getState('items'))[0]?.status).toBe('approved')

			await device.sync()
			await device.sync()
			expect(await device.store.loadAuthoritativeNodeIds()).not.toContain('admin-svc')
			expect((await device.getState('items'))[0]?.status).toBe('client')
			expect((await serverStore.findRecord('items', 'i1'))?.status).toBe('client')
		} finally {
			await network.close()
		}
	}, 60_000)
})
