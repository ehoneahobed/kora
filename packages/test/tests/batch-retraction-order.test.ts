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
import { afterEach, describe, expect, test, vi } from 'vitest'
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

describe('a quarantined insert and its retraction in one batch', () => {
	test('the insert replayed from quarantine does not show the retracted record', async () => {
		net = await scopedNetwork(schema, { auth })
		const device = await net.device({ name: 'drift', token: 'school-0', scopeExit: 'retract' })
		await settle([device])
		await device.disconnect()
		const kora = net.server.getKoraContext()
		const apply = async (
			type: 'insert' | 'update',
			id: string,
			data: Record<string, unknown>,
		): Promise<void> => {
			const result = await kora.apply({ collection: 'lessons', type, recordId: id, data })
			expect(result.ok).toBe(true)
		}
		await apply('insert', 'left', { title: 'left', school: 'school-0' })
		await apply('update', 'left', { school: 'school-1' })
		await apply('insert', 'kept', { title: 'kept', school: 'school-0' })

		// The device's clock falls 10 minutes behind after its handshake measured the skew:
		// every delivered operation now looks more than 5 minutes ahead and is quarantined
		// (as an undecryptable or not-yet-transformable one would be), while the
		// retraction of `left` in the same batch applies to a record with no row.
		const realNow = Date.now.bind(Date)
		const drift = vi.spyOn(Date, 'now')
		let quarantined = 0
		device.emitter.on('sync:apply-failed', (event) => {
			if (event.code === 'REMOTE_CLOCK_DRIFT') quarantined++
		})
		device.emitter.on('sync:connected', () => {
			drift.mockImplementation(() => realNow() - 10 * 60_000)
		})
		try {
			await settle([device])
			expect(quarantined).toBeGreaterThan(0)
			expect(await ids(device)).toEqual([])
		} finally {
			drift.mockRestore()
		}

		// Time is right again: the quarantine replays. `kept` shows; `left` stays hidden.
		await device.getSyncEngine()?.retryQuarantinedOperations()
		expect(await ids(device)).toEqual(['kept'])
	}, 60_000)
})

describe('a record leaving and re-entering the view through server inserts', () => {
	const apply = async (
		network: ScopedNetwork,
		type: 'insert' | 'update',
		id: string,
		data: Record<string, unknown>,
	): Promise<void> => {
		const result = await network.server
			.getKoraContext()
			.apply({ collection: 'lessons', type, recordId: id, data })
		expect(result.ok).toBe(true)
	}

	test('an explicit-id insert that puts a retracted record back in scope shows it', async () => {
		net = await scopedNetwork(schema, { auth })
		const device = await net.device({ name: 'reentry', token: 'school-0', scopeExit: 'retract' })
		await apply(net, 'insert', 'x', { title: 'x', school: 'school-0' })
		await settle([device])
		expect(await ids(device)).toEqual(['x'])
		await apply(net, 'update', 'x', { school: 'school-1' })
		await settle([device])
		expect(await ids(device)).toEqual([])
		// Back in scope through an insert onto the existing record (no scope entry before
		// this change): the device must show it, live and offline-resumed alike.
		await apply(net, 'insert', 'x', { title: 'x again', school: 'school-0' })
		await settle([device])
		expect(await ids(device)).toEqual(['x'])
		await device.disconnect()
		await settle([device])
		expect(await ids(device)).toEqual(['x'])
	}, 60_000)

	test('an explicit-id insert that moves a record out of scope retracts it', async () => {
		net = await scopedNetwork(schema, { auth })
		const device = await net.device({ name: 'out', token: 'school-0', scopeExit: 'retract' })
		await apply(net, 'insert', 'y', { title: 'y', school: 'school-0' })
		await settle([device])
		expect(await ids(device)).toEqual(['y'])
		await apply(net, 'insert', 'y', { title: 'y', school: 'school-1' })
		await settle([device])
		expect(await ids(device)).toEqual([])
		// A fresh device never sees it either.
		const fresh = await net.device({ name: 'out-fresh', token: 'school-0', scopeExit: 'retract' })
		await settle([fresh])
		expect(await ids(fresh)).toEqual([])
	}, 60_000)

	test('a duplicate re-delivery of an earlier insert does not show a retracted record', async () => {
		net = await scopedNetwork(schema, { auth })
		let firstBatch: SyncMessage | null = null
		let replay: ((message: SyncMessage) => void) | null = null
		net.intercept.set('dup', (message, transport) => {
			if (message.type === 'operation-batch' && message.operations.length > 0 && !firstBatch) {
				firstBatch = JSON.parse(JSON.stringify(message)) as SyncMessage
			}
			replay = (m) => transport.send(m)
			return true
		})
		const device = await net.device({ name: 'dup', token: 'school-0', scopeExit: 'retract' })
		await apply(net, 'insert', 'z', { title: 'z', school: 'school-0' })
		await settle([device])
		await apply(net, 'update', 'z', { school: 'school-1' })
		await settle([device])
		expect(await ids(device)).toEqual([])
		// Re-deliver the batch that carried z's insert, as a retransmission crossing an
		// ack does, and once more as a relay without delivery positions.
		expect(firstBatch).not.toBeNull()
		const original = firstBatch as unknown as SyncMessage & { type: 'operation-batch' }
		const send = replay as unknown as (message: SyncMessage) => void
		send({ ...original, messageId: 'resend-1' })
		const {
			baseDeliverySequence: _b,
			maxDeliverySequence: _m,
			operationSequences: _s,
			...relay
		} = original
		send({ ...relay, messageId: 'resend-2' } as SyncMessage)
		await settle([device])
		expect(await ids(device)).toEqual([])
	}, 60_000)

	test('a widened grant after a quarantined insert shows the record', async () => {
		const widenable = new TokenAuthProvider({
			validate: async (token) => ({
				userId: token,
				scopes: {
					lessons:
						token === 'wide'
							? { school: { $in: ['school-0', 'school-1'] } }
							: { school: 'school-0' },
				},
			}),
		})
		net = await scopedNetwork(schema, { auth: widenable })
		let token = 'narrow'
		net.handshakeRewrite.set(
			'widen',
			(message: SyncMessage): SyncMessage =>
				message.type === 'handshake' ? ({ ...message, authToken: token } as SyncMessage) : message,
		)
		const device = await net.device({ name: 'widen', token: 'narrow', scopeExit: 'retract' })
		await settle([device])
		await device.disconnect()
		const kora = net.server.getKoraContext()
		expect(
			(
				await kora.apply({
					collection: 'lessons',
					type: 'insert',
					recordId: 'q',
					data: { title: 'q', school: 'school-0' },
				})
			).ok,
		).toBe(true)
		expect(
			(
				await kora.apply({
					collection: 'lessons',
					type: 'update',
					recordId: 'q',
					data: { school: 'school-1' },
				})
			).ok,
		).toBe(true)

		// The insert of q is quarantined (clock drift) while its retraction applies.
		const realNow = Date.now.bind(Date)
		const drift = vi.spyOn(Date, 'now')
		let phase: 'drift-after-connect' | 'real-after-connect' = 'drift-after-connect'
		device.emitter.on('sync:connected', () => {
			if (phase === 'drift-after-connect') drift.mockImplementation(() => realNow() - 10 * 60_000)
			else drift.mockImplementation(realNow)
		})
		const retracted: string[] = []
		device.emitter.on('sync:scope-retracted', (event) => retracted.push(event.recordId))
		try {
			await settle([device])
			expect(await ids(device)).toEqual([])
			expect((await device.getSyncEngine()?.getQuarantinedOperations())?.length).toBeGreaterThan(0)
			expect(retracted).toContain('q')

			// The grant widens to school-1. The clock is still behind while the reconnect
			// starts, so the quarantine replay on start fails again; once connected (the
			// handshake measured the skew) time is right. The new view restarts from 0 and
			// delivers q's insert as an ordinary, never-logged insert: q must show.
			phase = 'real-after-connect'
			token = 'wide'
			await device.disconnect()
			await settle([device])
			expect(await ids(device)).toEqual(['q'])
		} finally {
			drift.mockRestore()
		}
		// The quarantined copy replays later as a duplicate of an earlier delivery: q stays.
		await device.getSyncEngine()?.retryQuarantinedOperations()
		expect(await ids(device)).toEqual(['q'])
	}, 60_000)
})

describe('forceFullResync repairs a device that kept a retracted record', () => {
	test('the replay from watermark 0 hides the record; the request completes once', async () => {
		net = await scopedNetwork(schema, { auth })
		// A device that kept a record outside its view: it never applied the retraction
		// (the state an unpatched client could end in).
		let dropRetractions = true
		net.intercept.set('leaked', (message) => {
			if (message.type === 'operation-batch' && dropRetractions) message.retractions = undefined
			return true
		})
		const kept = await writeFixture(net)
		const device = await net.device({ name: 'leaked', token: 'school-0', scopeExit: 'retract' })
		await settle([device])
		expect(await ids(device)).toEqual([...kept, 'moved-0', 'moved-1', 'moved-2'].sort())

		// Re-connecting does not repair it: a resumed stream holds nothing new.
		dropRetractions = false
		await device.disconnect()
		await settle([device])
		expect(await ids(device)).toContain('moved-0')

		// The operator lever, for a device that is online: its session ends at once.
		const complete = vi.spyOn(net.store, 'completeFullResync')
		expect(await net.server.forceFullResync({ userId: 'school-0' })).toBe(1)
		await settle([device])
		expect(await ids(device)).toEqual(kept)
		// Recorded done for the view the device streams under.
		const state = await net.store.getFullResyncState('school-0', device.getNodeId())
		expect(complete).toHaveBeenCalledTimes(1)
		expect(complete.mock.calls[0]?.[1]).toBe(state.requested)

		// Done: the next connection resumes instead of restarting from 0.
		const watermark = device.getSyncEngine()?.getStatus().deliveryWatermark ?? 0
		expect(watermark).toBeGreaterThan(0)
		await device.disconnect()
		await settle([device])
		expect(device.getSyncEngine()?.getStatus().deliveryWatermark).toBe(watermark)
		expect(await ids(device)).toEqual(kept)
	}, 60_000)

	test('a device offline at the request resyncs when it next connects', async () => {
		net = await scopedNetwork(schema, { auth })
		let dropRetractions = true
		net.intercept.set('offline', (message) => {
			if (message.type === 'operation-batch' && dropRetractions) message.retractions = undefined
			return true
		})
		const kept = await writeFixture(net)
		const device = await net.device({ name: 'offline', token: 'school-0', scopeExit: 'retract' })
		await settle([device])
		await device.disconnect()
		dropRetractions = false
		expect(await net.server.forceFullResync({ nodeId: device.getNodeId() })).toBe(0)
		await settle([device])
		expect(await ids(device)).toEqual(kept)
	}, 60_000)

	test('a device with two delivery views restarts each one', async () => {
		net = await scopedNetwork(schema, { auth })
		let dropRetractions = true
		net.intercept.set('views', (message) => {
			if (message.type === 'operation-batch' && dropRetractions) message.retractions = undefined
			return true
		})
		const kept = await writeFixture(net)
		const device = await net.device({
			name: 'views',
			token: 'school-0',
			scopeExit: 'retract',
			reconnectable: true,
		})
		// View A (no query subset) kept the moved records.
		await settle([device])
		expect(await ids(device)).toEqual([...kept, 'moved-0', 'moved-1', 'moved-2'].sort())
		dropRetractions = false
		const engine = device.getSyncEngine()
		if (!engine) throw new Error('not connected')

		// The device switches to view B (a query subset; it keeps view A's watermark) and
		// is streaming under it when the operator asks for a full resync. View B restarts
		// and completes the request for B only.
		const complete = vi.spyOn(net.store, 'completeFullResync')
		engine.registerQuerySubset({ collection: 'lessons', where: { title: 'stays-0' } })
		await engine.reconnect()
		await settle([device])
		await net.server.forceFullResync({ nodeId: device.getNodeId() })
		await engine.reconnect()
		await settle([device])
		await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))

		// Back under view A (a new engine has no subsets): A restarts too, and its replay
		// hides the moved records. Without per-view completion, A resumed past them.
		await device.disconnect()
		await settle([device])
		expect(await ids(device)).toEqual(kept)
		await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2))
		expect(complete.mock.calls[1]?.[2]).not.toBe(complete.mock.calls[0]?.[2])
	}, 60_000)

	test('needs a user or node id', async () => {
		net = await scopedNetwork(schema, { auth })
		await expect(net.server.forceFullResync({})).rejects.toThrow('needs a userId or a nodeId')
	})
})
