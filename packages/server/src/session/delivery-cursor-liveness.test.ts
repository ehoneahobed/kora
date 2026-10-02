import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import type { OperationBatchMessage, SyncMessage } from '@korajs/sync'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'
import type { ServerTransport } from '../transport/server-transport'
import { ClientSession, type ClientSessionOptions } from './client-session'
import { SessionRateLimiter } from './session-operation-limits'

/**
 * The delivery send cursor (SRV-3), the streamed delivery (SRV-5) and the session's
 * liveness duties (SRV-6, LMS #12). Time is always fake: nothing here waits on a clock.
 */

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), done: t.boolean().default(false) } } },
})

let sequence = 0
function op(id: string, overrides: Partial<Operation> = {}): Operation {
	sequence += 1
	return {
		id,
		nodeId: 'writer',
		type: 'insert',
		collection: 'todos',
		recordId: `rec-${id}`,
		data: { title: id, done: false },
		previousData: null,
		timestamp: { wallTime: 1_000 + sequence, logical: 0, nodeId: 'writer' },
		sequenceNumber: sequence,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

function batches(messages: SyncMessage[]): OperationBatchMessage[] {
	return messages.filter((m): m is OperationBatchMessage => m.type === 'operation-batch')
}

async function seededStore(count: number): Promise<MemoryServerStore> {
	const store = new MemoryServerStore('server')
	await store.setSchema(schema)
	for (let i = 1; i <= count; i++) await store.applyRemoteOperation(op(`o${i}`))
	return store
}

function start(
	store: MemoryServerStore,
	options: Partial<ClientSessionOptions> = {},
	wrapTransport?: (transport: ServerTransport) => ServerTransport,
) {
	const pair = createServerTransportPair()
	const messages: SyncMessage[] = []
	pair.client.onMessage((m) => messages.push(m))
	const transport = wrapTransport ? wrapTransport(pair.server) : pair.server
	const session = new ClientSession({
		sessionId: 's',
		transport,
		store,
		batchSize: 2,
		...options,
	})
	session.start()
	return { client: pair.client, messages, session }
}

function handshake(extra: Record<string, unknown> = {}): SyncMessage {
	return {
		type: 'handshake',
		messageId: 'hs',
		nodeId: 'reader',
		versionVector: {},
		schemaVersion: 1,
		lastDeliverySequence: 0,
		...extra,
	} as SyncMessage
}

function ack(max: number): SyncMessage {
	return {
		type: 'acknowledgment',
		messageId: `ack-${max}`,
		acknowledgedMessageId: 'x',
		lastSequenceNumber: 0,
		deliverySequence: max,
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe('delivery send cursor (SRV-3)', () => {
	test('a live push chains from the last batch sent and carries only new operations', async () => {
		const store = await seededStore(3)
		const { client, messages, session } = start(store)
		client.send(handshake())
		await vi.waitFor(() => expect(batches(messages).some((b) => b.isFinal)).toBe(true))
		const initial = batches(messages)
		expect(initial.at(-1)?.maxDeliverySequence).toBe(3)

		// Nothing is acknowledged yet: a new write must still go out alone, based on 3.
		const live = op('o4')
		await store.applyRemoteOperation(live)
		session.relayOperations([live])
		await vi.waitFor(() => expect(batches(messages).length).toBe(initial.length + 1))
		const pushed = batches(messages).at(-1)
		expect(pushed?.baseDeliverySequence).toBe(3)
		expect(pushed?.maxDeliverySequence).toBe(4)
		expect(pushed?.operations.map((o) => o.id)).toEqual(['o4'])
	})

	test('an unacknowledged delivery is re-sent from the acknowledged position after the retransmit timeout, backing off', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'Date'] })
		const store = await seededStore(4)
		const { client, messages } = start(store)
		client.send(handshake())
		await vi.advanceTimersByTimeAsync(0)
		const sent = batches(messages).length
		expect(batches(messages).map((b) => [b.baseDeliverySequence, b.maxDeliverySequence])).toEqual([
			[0, 2],
			[2, 4],
		])
		client.send(ack(2)) // the first batch was applied; the second was lost

		// The ack's round trip (0 ms here) puts the timeout at its 1 s floor.
		await vi.advanceTimersByTimeAsync(900)
		expect(batches(messages).length).toBe(sent)
		await vi.advanceTimersByTimeAsync(200)
		const resent = batches(messages).slice(sent)
		expect(resent.map((b) => [b.baseDeliverySequence, b.maxDeliverySequence])).toEqual([[2, 4]])

		// Still unacknowledged: the timeout doubles (2 s) before the next re-send.
		await vi.advanceTimersByTimeAsync(1_800)
		expect(batches(messages).length).toBe(sent + 1)
		await vi.advanceTimersByTimeAsync(200)
		expect(batches(messages).length).toBe(sent + 2)
		// ...and again (4 s).
		await vi.advanceTimersByTimeAsync(3_800)
		expect(batches(messages).length).toBe(sent + 2)
		await vi.advanceTimersByTimeAsync(200)
		expect(batches(messages).length).toBe(sent + 3)

		// An acknowledgment of everything stops the re-sends.
		client.send(ack(4))
		await vi.advanceTimersByTimeAsync(600_000)
		expect(batches(messages).length).toBe(sent + 3)
	})

	test('acknowledgment progress resets the backoff and never passes what was sent', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'Date'] })
		const store = await seededStore(2)
		const { client, messages, session } = start(store)
		client.send(handshake())
		await vi.advanceTimersByTimeAsync(0)
		// A forged ack beyond the stream cannot make the server skip later operations.
		client.send(ack(1_000))
		const later = op('o3')
		await store.applyRemoteOperation(later)
		session.relayOperations([later])
		await vi.advanceTimersByTimeAsync(0)
		const pushed = batches(messages).at(-1)
		expect(pushed?.operations.map((o) => o.id)).toEqual(['o3'])
		expect(pushed?.baseDeliverySequence).toBe(2)
	})

	test('the delivery poll re-sends only once the window passed, not on every tick', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'Date'] })
		const store = await seededStore(2)
		const { client, messages, session } = start(store)
		client.send(handshake())
		await vi.advanceTimersByTimeAsync(0)
		const sent = batches(messages).length
		for (let i = 0; i < 10; i++) {
			session.pushDeliveryStreamIfSupported(50, { serverFrontier: 2 })
			await vi.advanceTimersByTimeAsync(50)
		}
		// 500 ms of ticks at 50 ms: below the 2 s retransmit window, nothing re-sent.
		expect(batches(messages).length).toBe(sent)
	})
})

describe('streamed delivery (SRV-5)', () => {
	test('the first batch is sent after one scan chunk, and only the last batch is final', async () => {
		const store = await seededStore(40) // batchSize 2 -> scan chunks of 10
		const { client, messages } = start(store)
		client.send(handshake())
		await vi.waitFor(() => expect(batches(messages).some((b) => b.isFinal)).toBe(true))
		const stream = batches(messages)
		expect(stream).toHaveLength(20)
		expect(stream.filter((b) => b.isFinal)).toHaveLength(1)
		expect(stream.at(-1)?.isFinal).toBe(true)
		// Chained without gaps from 0 to 40.
		let base = 0
		for (const batch of stream) {
			expect(batch.baseDeliverySequence).toBe(base)
			base = batch.maxDeliverySequence ?? base
		}
		expect(base).toBe(40)
	})

	test('first send happens before the whole log is scanned', async () => {
		const store = await seededStore(40)
		let scanned = 0
		let scannedAtFirstBatch: number | null = null
		const original = store.getOperationsAfterDelivery.bind(store)
		store.getOperationsAfterDelivery = async (after, limit) => {
			const chunk = await original(after, limit)
			scanned += chunk.length
			return chunk
		}
		const pair = createServerTransportPair()
		pair.client.onMessage((m) => {
			if (m.type === 'operation-batch' && scannedAtFirstBatch === null)
				scannedAtFirstBatch = scanned
		})
		const session = new ClientSession({
			sessionId: 's',
			transport: pair.server,
			store,
			batchSize: 2,
		})
		session.start()
		pair.client.send(handshake())
		await vi.waitFor(() => expect(scannedAtFirstBatch).not.toBeNull())
		expect(scannedAtFirstBatch).toBe(10)
	})

	test('the stream pauses while the transport is over its high-water mark', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'Date'] })
		const store = await seededStore(10)
		let buffered = 0
		const { client, messages } = start(
			store,
			{ deliveryHighWaterBytes: 100 },
			(inner): ServerTransport => ({
				send: (message: SyncMessage) => {
					inner.send(message)
					if (message.type === 'operation-batch') buffered += 1_000
				},
				onMessage: (handler) => inner.onMessage(handler),
				onClose: (handler) => inner.onClose(handler),
				onError: (handler) => inner.onError(handler),
				isConnected: () => inner.isConnected(),
				close: (code, reason) => inner.close(code, reason),
				bufferedAmount: () => buffered,
			}),
		)
		client.send(handshake())
		await vi.advanceTimersByTimeAsync(100)
		expect(batches(messages)).toHaveLength(1)
		buffered = 0 // the client drained its socket
		await vi.advanceTimersByTimeAsync(30)
		expect(batches(messages)).toHaveLength(2)
	})

	test('records needed for visibility are read in one batched lookup per chunk', async () => {
		const store = await seededStore(12)
		const byIds = vi.spyOn(store, 'findRecordsByIds')
		const perRecord = vi.spyOn(store, 'queryCollection')
		const { client, messages } = start(store)
		// A query subset needs every record's current row.
		client.send(handshake({ syncQueries: [{ collection: 'todos', where: { done: false } }] }))
		await vi.waitFor(() => expect(batches(messages).some((b) => b.isFinal)).toBe(true))
		expect(byIds).toHaveBeenCalledTimes(2) // chunks of 10: 10 + 2 operations
		expect(perRecord).not.toHaveBeenCalled()
		expect(batches(messages).flatMap((b) => b.operations)).toHaveLength(12)
	})
})

describe('session liveness (SRV-6, LMS #12)', () => {
	test('a connection that sends no handshake is closed at the deadline', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'Date'] })
		const store = await seededStore(0)
		const { messages, session } = start(store, { handshakeTimeoutMs: 10_000 })
		await vi.advanceTimersByTimeAsync(9_999)
		expect(session.getState()).toBe('connected')
		await vi.advanceTimersByTimeAsync(1)
		expect(session.getState()).toBe('closed')
		expect(messages.some((m) => m.type === 'error' && m.code === 'HANDSHAKE_TIMEOUT')).toBe(true)
	})

	test('a handshake before the deadline cancels it', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'Date'] })
		const store = await seededStore(0)
		const { client, session } = start(store, { handshakeTimeoutMs: 10_000 })
		client.send(handshake())
		await vi.advanceTimersByTimeAsync(60_000)
		expect(session.getState()).toBe('streaming')
	})

	test('a client that advertises heartbeats is told the interval and hears one when idle', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'Date'] })
		const store = await seededStore(0)
		const { client, messages } = start(store, { appHeartbeatIntervalMs: 25_000 })
		client.send(handshake({ supportsHeartbeat: true }))
		await vi.advanceTimersByTimeAsync(0)
		const response = messages.find((m) => m.type === 'handshake-response')
		expect(response?.type === 'handshake-response' && response.heartbeatIntervalMs).toBe(25_000)
		await vi.advanceTimersByTimeAsync(25_000)
		expect(messages.filter((m) => m.type === 'heartbeat')).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(25_000)
		expect(messages.filter((m) => m.type === 'heartbeat')).toHaveLength(2)
	})

	test('a client that does not advertise heartbeats never receives one', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'Date'] })
		const store = await seededStore(0)
		const { client, messages } = start(store, { appHeartbeatIntervalMs: 25_000 })
		client.send(handshake())
		await vi.advanceTimersByTimeAsync(100_000)
		const response = messages.find((m) => m.type === 'handshake-response')
		expect(response?.type === 'handshake-response' && response.heartbeatIntervalMs).toBe(undefined)
		expect(messages.some((m) => m.type === 'heartbeat')).toBe(false)
	})

	test('the ingest rate limit is the node limiter handed in at handshake', async () => {
		const store = await seededStore(0)
		const shared = new SessionRateLimiter(2)
		shared.allow(2) // the node spent its budget in an earlier session
		const { client, messages } = start(store, { rateLimiterFor: () => shared })
		client.send(handshake())
		await vi.waitFor(() => expect(messages.some((m) => m.type === 'handshake-response')).toBe(true))
		client.send({
			type: 'operation-batch',
			messageId: 'b',
			operations: [
				op('mine', {
					nodeId: 'reader',
					timestamp: { wallTime: Date.now(), logical: 0, nodeId: 'reader' },
				}),
			],
			isFinal: true,
			batchIndex: 0,
		})
		await vi.waitFor(() =>
			expect(messages.some((m) => m.type === 'error' && m.code === 'RATE_LIMIT')).toBe(true),
		)
	})
})
