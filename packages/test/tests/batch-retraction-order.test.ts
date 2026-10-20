/**
 * A record that enters a device's scope and leaves it again within one delivery batch
 * must end hidden on a `scopeExit: 'retract'` device, and one that leaves and comes
 * back within one batch must end visible.
 *
 * The server sends a batch's retractions next to its operations. A client that applied
 * every retraction before the batch's operations retracted such a record before its
 * insert existed, and the insert then materialized it live: the device kept a record
 * outside its grant. Retractions now carry their stream position and apply in order;
 * for clients that do not declare that, the server cuts the batch before the
 * retraction instead.
 */
import { defineSchema, t } from '@korajs/core'
import { TokenAuthProvider } from '@korajs/server'
import type { SyncMessage } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import type { TestDevice } from '../src/index'
import { type ScopedNetwork, scopedNetwork, settle } from './repro/scoped-network'

const schema = defineSchema({
	version: 1,
	collections: {
		lessons: { fields: { title: t.string(), school: t.string() } },
	},
})

const auth = new TokenAuthProvider({
	validate: async (token) => ({ userId: token, scopes: { lessons: { school: token } } }),
})

let net: ScopedNetwork | null = null
afterEach(async () => {
	await net?.close()
	net = null
})

async function ids(device: TestDevice): Promise<string[]> {
	return (await device.getState('lessons')).map((row) => String((row as { id: string }).id)).sort()
}

/**
 * Write through the server: `moved-*` is inserted in school-0 and moved to school-1,
 * `returned-*` leaves school-0 and comes back, `stays-*` remains in school-0. Every
 * write lands in one delivery batch (the default batch size is far larger).
 */
async function writeFixture(network: ScopedNetwork): Promise<string[]> {
	const kora = network.server.getKoraContext()
	const insert = async (id: string, school: string): Promise<void> => {
		const result = await kora.apply({
			collection: 'lessons',
			type: 'insert',
			recordId: id,
			data: { title: id, school },
		})
		expect(result.ok).toBe(true)
	}
	const move = async (id: string, school: string): Promise<void> => {
		const result = await kora.apply({
			collection: 'lessons',
			type: 'update',
			recordId: id,
			data: { school },
		})
		expect(result.ok).toBe(true)
	}
	const kept: string[] = []
	for (let i = 0; i < 3; i++) {
		await insert(`moved-${i}`, 'school-0')
		await insert(`stays-${i}`, 'school-0')
		await move(`moved-${i}`, 'school-1')
		await insert(`returned-${i}`, 'school-0')
		await move(`returned-${i}`, 'school-1')
		await move(`returned-${i}`, 'school-0')
		kept.push(`stays-${i}`, `returned-${i}`)
	}
	return kept.sort()
}

describe('retractions apply in stream order within a delivery batch', () => {
	test('initial sync: a record inserted and moved out in one batch is not kept', async () => {
		net = await scopedNetwork(schema, { auth })
		const kept = await writeFixture(net)
		const device = await net.device({ name: 'fresh', token: 'school-0', scopeExit: 'retract' })
		await settle([device])
		expect(await ids(device)).toEqual(kept)
	}, 60_000)

	test('resumed stream: the same writes made while the device was offline', async () => {
		net = await scopedNetwork(schema, { auth })
		const device = await net.device({ name: 'resumed', token: 'school-0', scopeExit: 'retract' })
		await settle([device])
		await device.disconnect()
		const kept = await writeFixture(net)
		await settle([device])
		expect(await ids(device)).toEqual(kept)
	}, 60_000)

	test('an older client (no ordered retractions) gets batches cut before the retraction', async () => {
		net = await scopedNetwork(schema, { auth })
		// Strip the capability from the handshake, as a client without it sends.
		net.handshakeRewrite.set('older', (message: SyncMessage): SyncMessage => {
			if (message.type !== 'handshake') return message
			const { orderedRetractions: _omitted, ...rest } = message
			return { ...rest, authToken: 'school-0' } as SyncMessage
		})
		const batches: Array<{ operations: number; retractions: number }> = []
		net.intercept.set('older', (message) => {
			if (message.type === 'operation-batch') {
				// Drop the positions too: the device then applies every retraction before the
				// batch's operations, as an older client does, so only the cut can keep it right.
				for (const retraction of message.retractions ?? []) retraction.afterOperations = undefined
				batches.push({
					operations: message.operations.length,
					retractions: message.retractions?.length ?? 0,
				})
			}
			return true
		})
		const kept = await writeFixture(net)
		const device = await net.device({ name: 'older', token: 'school-0', scopeExit: 'retract' })
		await settle([device])
		expect(await ids(device)).toEqual(kept)
		// Each retraction of a record inserted earlier in the batch starts a new batch.
		expect(batches.filter((batch) => batch.retractions > 0).length).toBeGreaterThanOrEqual(3)
	}, 60_000)
})
