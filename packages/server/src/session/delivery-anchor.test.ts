import type { Operation } from '@korajs/core'
import type { OperationBatchMessage, SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'
import { ClientSession } from './client-session'

/**
 * Delivery anchors: each delivery batch names the newest operation at or below its max
 * sequence, and a reconnecting client reports the one for its watermark. A server whose
 * log was rewound and written past the client's position again holds a different
 * operation there, and resyncs the client from 0 instead of resuming above writes it
 * never sent. A restore Kora never saw (a database-level one) is caught the same way.
 */

let sequence = 0
function op(id: string): Operation {
	sequence += 1
	return {
		id,
		nodeId: 'node-a',
		type: 'insert',
		collection: 'todos',
		recordId: `rec-${id}`,
		data: { title: id },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
		sequenceNumber: sequence,
		causalDeps: [],
		schemaVersion: 1,
	}
}

async function storeWith(ids: string[]): Promise<MemoryServerStore> {
	const store = new MemoryServerStore('server-1')
	for (const id of ids) await store.applyRemoteOperation(op(id))
	return store
}

function batches(messages: SyncMessage[]): OperationBatchMessage[] {
	return messages.filter((m): m is OperationBatchMessage => m.type === 'operation-batch')
}

async function handshake(store: MemoryServerStore, fields: Record<string, unknown>) {
	const { client, server } = createServerTransportPair()
	const messages: SyncMessage[] = []
	client.onMessage((m) => messages.push(m))
	const logs: string[] = []
	const session = new ClientSession({
		sessionId: 's1',
		transport: server,
		store,
		batchSize: 10,
		logger: { log: (entry) => logs.push(entry.event) },
	})
	session.start()
	client.send({
		type: 'handshake',
		protocolVersion: 2,
		messageId: 'hs',
		nodeId: 'client-1',
		versionVector: {},
		schemaVersion: 1,
		...fields,
	} as SyncMessage)
	await vi.waitFor(() => expect(batches(messages).some((batch) => batch.isFinal)).toBe(true))
	const response = messages.find((m) => m.type === 'handshake-response')
	return {
		batches: batches(messages),
		advertised:
			response?.type === 'handshake-response' ? response.serverMaxDeliverySequence : undefined,
		logs,
	}
}

describe('delivery anchors', () => {
	test('each delivery batch names the newest operation at or below its max sequence', async () => {
		const store = await storeWith(['a', 'b', 'c'])
		const { batches: sent } = await handshake(store, { lastDeliverySequence: 0 })
		expect(sent.at(-1)?.maxDeliverySequence).toBe(3)
		expect(sent.at(-1)?.deliveryAnchor).toBe('c')
		expect(await store.getDeliveryAnchor(2)).toBe('b')
		expect(await store.getDeliveryAnchor(0)).toBeNull()
	})

	test('a client in step with the log resumes from its watermark', async () => {
		const store = await storeWith(['a', 'b', 'c'])
		const { batches: sent, advertised } = await handshake(store, {
			lastDeliverySequence: 2,
			lastDeliveryAnchor: 'b',
		})
		expect(advertised).toBe(3)
		expect(sent[0]?.baseDeliverySequence).toBe(2)
		expect(sent.flatMap((batch) => batch.operations.map((o) => o.id))).toEqual(['c'])
	})

	test('a log rewound and written past the client again resyncs it from zero', async () => {
		// The client was in step at 3, with "c" there. The server was then restored to a
		// point holding only "a" and "b", and new writes took sequences 3 and 4.
		const store = await storeWith(['a', 'b', 'x', 'y'])
		const {
			batches: sent,
			advertised,
			logs,
		} = await handshake(store, { lastDeliverySequence: 3, lastDeliveryAnchor: 'c' })
		// Below the client's watermark, which every watermark client resets on.
		expect(advertised).toBe(2)
		expect(sent[0]?.baseDeliverySequence).toBe(0)
		// Nothing written after the restore is skipped; the rest dedups by id on the client.
		expect(sent.flatMap((batch) => batch.operations.map((o) => o.id))).toEqual(['a', 'b', 'x', 'y'])
		expect(logs).toContain('session.delivery_log_rewound')
	})

	test("any other operation at the client's position counts as a rewind", async () => {
		const store = await storeWith(['a', 'b', 'c'])
		const inStep = await handshake(store, { lastDeliverySequence: 3, lastDeliveryAnchor: 'c' })
		expect(inStep.batches[0]?.baseDeliverySequence).toBe(3)
		const rewound = await handshake(store, { lastDeliverySequence: 3, lastDeliveryAnchor: 'q' })
		expect(rewound.batches[0]?.baseDeliverySequence).toBe(0)
	})

	test('a client that sends no anchor keeps the old behavior', async () => {
		const store = await storeWith(['a', 'b', 'x', 'y'])
		const { batches: sent, advertised } = await handshake(store, { lastDeliverySequence: 3 })
		expect(advertised).toBe(4)
		expect(sent[0]?.baseDeliverySequence).toBe(3)
	})

	test('a malformed anchor is ignored rather than trusted', async () => {
		const store = await storeWith(['a', 'b', 'c'])
		const { batches: sent } = await handshake(store, {
			lastDeliverySequence: 2,
			lastDeliveryAnchor: 'x'.repeat(500),
		})
		expect(sent[0]?.baseDeliverySequence).toBe(2)
	})
})
