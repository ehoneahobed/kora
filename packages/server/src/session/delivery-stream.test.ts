import type { Operation } from '@korajs/core'
import type { OperationBatchMessage, SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'
import type { AuthProvider } from '../types'
import { ClientSession } from './client-session'

/**
 * Server-side delivery stream. A handshake that carries `lastDeliverySequence` makes the
 * session resume the gap-free server->client stream from that watermark instead of the
 * version-vector delta: it sends only operations above the watermark, in delivery order,
 * in batches that chain base -> max. A handshake without the field keeps the legacy delta.
 */

function op(id: string): Operation {
	return {
		id,
		nodeId: 'node-a',
		type: 'insert',
		collection: 'todos',
		recordId: `rec-${id}`,
		data: { title: id },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	}
}

function batches(messages: SyncMessage[]): OperationBatchMessage[] {
	return messages.filter((m): m is OperationBatchMessage => m.type === 'operation-batch')
}

async function seed(store: MemoryServerStore, ids: string[]): Promise<void> {
	for (const id of ids) {
		await store.applyRemoteOperation(op(id))
	}
}

function startSession(store: MemoryServerStore, batchSize?: number, auth?: AuthProvider) {
	const { client, server } = createServerTransportPair()
	const messages: SyncMessage[] = []
	client.onMessage((m) => messages.push(m))
	const session = new ClientSession({ sessionId: 's1', transport: server, store, batchSize, auth })
	session.start()
	return { client, messages, session }
}

describe('server delivery stream', () => {
	test('resumes from the reported watermark, sending only later operations, chained', async () => {
		const store = new MemoryServerStore('server-1')
		await seed(store, ['o1', 'o2', 'o3', 'o4', 'o5']) // delivery seq 1..5
		const { client, messages } = startSession(store, 2)

		client.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'client-1',
			versionVector: {},
			schemaVersion: 1,
			lastDeliverySequence: 2, // already has o1, o2
		})

		await vi.waitFor(() => {
			expect(batches(messages).some((b) => b.isFinal)).toBe(true)
		})

		const opBatches = batches(messages)
		const sentIds = opBatches.flatMap((b) => b.operations.map((o) => o.id))
		expect(sentIds).toEqual(['o3', 'o4', 'o5']) // only above the watermark, in order

		// Batches chain: first base is the watermark; each base is the previous max.
		expect(opBatches[0]?.baseDeliverySequence).toBe(2)
		for (let i = 1; i < opBatches.length; i++) {
			expect(opBatches[i]?.baseDeliverySequence).toBe(opBatches[i - 1]?.maxDeliverySequence)
		}
		// The final batch carries the highest delivery sequence stored.
		const last = opBatches[opBatches.length - 1]
		expect(last?.isFinal).toBe(true)
		expect(last?.maxDeliverySequence).toBe(5)
	})

	test('watermark 0 sends the full in-scope stream from the beginning', async () => {
		const store = new MemoryServerStore('server-1')
		await seed(store, ['a', 'b', 'c'])
		const { client, messages } = startSession(store, 10)

		client.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'client-1',
			versionVector: {},
			schemaVersion: 1,
			lastDeliverySequence: 0,
		})

		await vi.waitFor(() => {
			expect(batches(messages).some((b) => b.isFinal)).toBe(true)
		})
		const sentIds = batches(messages).flatMap((b) => b.operations.map((o) => o.id))
		expect(sentIds).toEqual(['a', 'b', 'c'])
		expect(batches(messages)[0]?.baseDeliverySequence).toBe(0)
	})

	test('a caught-up client gets a single empty final batch chained at its watermark', async () => {
		const store = new MemoryServerStore('server-1')
		await seed(store, ['x', 'y'])
		const { client, messages } = startSession(store, 10)

		client.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'client-1',
			versionVector: {},
			schemaVersion: 1,
			lastDeliverySequence: 2, // already has everything
		})

		await vi.waitFor(() => {
			expect(batches(messages).some((b) => b.isFinal)).toBe(true)
		})
		const opBatches = batches(messages)
		expect(opBatches).toHaveLength(1)
		expect(opBatches[0]?.operations).toHaveLength(0)
		expect(opBatches[0]?.isFinal).toBe(true)
		expect(opBatches[0]?.baseDeliverySequence).toBe(2)
		expect(opBatches[0]?.maxDeliverySequence).toBe(2)
	})

	test('a handshake without a watermark keeps the legacy version-vector delta', async () => {
		const store = new MemoryServerStore('server-1')
		await seed(store, ['p', 'q'])
		const { client, messages } = startSession(store, 10)

		client.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'client-1',
			versionVector: {},
			schemaVersion: 1,
			// no lastDeliverySequence
		})

		await vi.waitFor(() => {
			expect(batches(messages).some((b) => b.isFinal)).toBe(true)
		})
		// Legacy batches do not carry the delivery-chain fields.
		for (const b of batches(messages)) {
			expect(b.baseDeliverySequence).toBeUndefined()
			expect(b.maxDeliverySequence).toBeUndefined()
		}
	})

	test('a resuming client is not sent its own operations, but the watermark still advances', async () => {
		const store = new MemoryServerStore('server-1')
		// delivery seq: 1 own, 2 other, 3 own, 4 other
		await store.applyRemoteOperation({ ...op('o1'), nodeId: 'client-1' })
		await store.applyRemoteOperation(op('o2'))
		await store.applyRemoteOperation({ ...op('o3'), nodeId: 'client-1' })
		await store.applyRemoteOperation(op('o4'))
		const { client, messages } = startSession(store, 10)

		client.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'client-1',
			versionVector: {},
			schemaVersion: 1,
			lastDeliverySequence: 1, // resuming; already has o1
		})

		await vi.waitFor(() => {
			expect(batches(messages).some((b) => b.isFinal)).toBe(true)
		})
		const opBatches = batches(messages)
		const sentIds = opBatches.flatMap((b) => b.operations.map((o) => o.id))
		// o3 is the client's own operation and is skipped; o2 and o4 are sent.
		expect(sentIds).toEqual(['o2', 'o4'])
		// The watermark still advances past the skipped own operation (max scanned is 4).
		expect(opBatches[opBatches.length - 1]?.maxDeliverySequence).toBe(4)
	})

	test('a full resync (watermark 0) still includes the client own operations', async () => {
		const store = new MemoryServerStore('server-1')
		await store.applyRemoteOperation({ ...op('o1'), nodeId: 'client-1' })
		await store.applyRemoteOperation(op('o2'))
		const { client, messages } = startSession(store, 10)

		client.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'client-1',
			versionVector: {},
			schemaVersion: 1,
			lastDeliverySequence: 0, // full resync (fresh or recovered client)
		})

		await vi.waitFor(() => {
			expect(batches(messages).some((b) => b.isFinal)).toBe(true)
		})
		const sentIds = batches(messages).flatMap((b) => b.operations.map((o) => o.id))
		expect(sentIds).toEqual(['o1', 'o2']) // own op recovered
	})

	test('streaming pushes resume from the acknowledged position, recovering an unacked batch', async () => {
		const store = new MemoryServerStore('server-1')
		await seed(store, ['a', 'b']) // delivery seq 1,2
		const { client, messages, session } = startSession(store, 10)

		client.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'client-1',
			versionVector: {},
			schemaVersion: 1,
			lastDeliverySequence: 0,
		})
		await vi.waitFor(() => expect(batches(messages).some((b) => b.isFinal)).toBe(true))

		// The client acknowledges through delivery sequence 2 (the handshake stream).
		client.send({
			type: 'acknowledgment',
			messageId: 'ack1',
			acknowledgedMessageId: batches(messages)[0]?.messageId ?? 'x',
			lastSequenceNumber: 0,
			deliverySequence: 2,
		})
		await new Promise((r) => setTimeout(r, 5))

		// A new op then a push: it must resume from the acked position (2) and send only c.
		messages.length = 0
		await store.applyRemoteOperation(op('c')) // delivery seq 3
		session.relayOperations([op('c')])
		await vi.waitFor(() => expect(batches(messages).length).toBeGreaterThan(0))
		const sentIds = batches(messages).flatMap((b) => b.operations.map((o) => o.id))
		expect(sentIds).toEqual(['c'])
		expect(batches(messages)[0]?.baseDeliverySequence).toBe(2)

		// Now WITHOUT a further ack, a re-push (as the retransmit tick does) resumes from
		// the still-acked position 2 and re-sends c, recovering it had the first send dropped.
		messages.length = 0
		session.retransmitPendingRelays(0)
		await vi.waitFor(() => expect(batches(messages).length).toBeGreaterThan(0))
		expect(batches(messages).flatMap((b) => b.operations.map((o) => o.id))).toEqual(['c'])
	})

	test('a watermark ahead of the server frontier resyncs from zero and advertises the max', async () => {
		const store = new MemoryServerStore('server-1')
		await seed(store, ['a', 'b']) // server max delivery seq = 2
		const { client, messages } = startSession(store, 10)

		client.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'client-1',
			versionVector: {},
			schemaVersion: 1,
			lastDeliverySequence: 100, // stale: server was rolled back below this
		})

		await vi.waitFor(() => {
			expect(batches(messages).some((b) => b.isFinal)).toBe(true)
		})
		const response = messages.find((m) => m.type === 'handshake-response')
		expect(response?.type).toBe('handshake-response')
		if (response?.type === 'handshake-response') {
			expect(response.serverMaxDeliverySequence).toBe(2)
		}
		// Resync from zero: everything is re-sent, chained from base 0.
		const opBatches = batches(messages)
		expect(opBatches[0]?.baseDeliverySequence).toBe(0)
		expect(opBatches.flatMap((b) => b.operations.map((o) => o.id))).toEqual(['a', 'b'])
	})

	test('server-authoritative scope mismatch invalidates the client delivery watermark', async () => {
		const store = new MemoryServerStore('server-1')
		await seed(store, ['a', 'b', 'c']) // delivery seq 1..3
		const auth: AuthProvider = {
			authenticate: async () => ({ userId: 'staff-1', scopes: { todos: {} } }),
		}
		const { client, messages } = startSession(store, 10, auth)

		client.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'client-1',
			versionVector: {},
			schemaVersion: 1,
			authToken: 'valid',
			lastDeliverySequence: 2,
		})

		await vi.waitFor(() => {
			expect(batches(messages).some((b) => b.isFinal)).toBe(true)
		})
		const opBatches = batches(messages)
		expect(opBatches[0]?.baseDeliverySequence).toBe(0)
		expect(opBatches.flatMap((b) => b.operations.map((o) => o.id))).toEqual(['a', 'b', 'c'])
	})
})
