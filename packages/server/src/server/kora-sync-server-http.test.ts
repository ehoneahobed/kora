import type { Operation } from '@kora/core'
import type { SyncMessage } from '@kora/sync'
import { JsonMessageSerializer } from '@kora/sync'
import { describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { KoraSyncServer } from './kora-sync-server'

function createTestOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: `op-${Math.random().toString(36).slice(2)}`,
		nodeId: 'client-a',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'test' },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'client-a' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

function handshake(nodeId: string): SyncMessage {
	return {
		type: 'handshake',
		messageId: `hs-${nodeId}`,
		nodeId,
		versionVector: {},
		schemaVersion: 1,
	}
}

describe('KoraSyncServer HTTP sync endpoint', () => {
	test('accepts handshake via POST and serves queued messages via GET', async () => {
		const serializer = new JsonMessageSerializer()
		const server = new KoraSyncServer({
			store: new MemoryServerStore('server-1'),
			serializer,
		})

		const postResponse = await server.handleHttpRequest({
			clientId: 'client-a',
			method: 'POST',
			contentType: 'application/json',
			body: serializer.encode(handshake('client-a')),
		})

		expect(postResponse.status).toBe(202)

		const firstPoll = await server.handleHttpRequest({
			clientId: 'client-a',
			method: 'GET',
		})
		expect(firstPoll.status).toBe(200)

		const responseMessage = serializer.decode(firstPoll.body as string)
		expect(responseMessage.type).toBe('handshake-response')
		expect(firstPoll.headers?.etag).toBeDefined()

		const secondPoll = await server.handleHttpRequest({
			clientId: 'client-a',
			method: 'GET',
		})
		expect(secondPoll.status).toBe(200)

		const finalBatch = serializer.decode(secondPoll.body as string)
		expect(finalBatch.type).toBe('operation-batch')

		const emptyPoll = await server.handleHttpRequest({
			clientId: 'client-a',
			method: 'GET',
		})
		expect(emptyPoll.status).toBe(204)
	})

	test('relays operations between long-polling clients', async () => {
		const serializer = new JsonMessageSerializer()
		const server = new KoraSyncServer({
			store: new MemoryServerStore('server-1'),
			serializer,
		})

		await server.handleHttpRequest({
			clientId: 'client-a',
			method: 'POST',
			contentType: 'application/json',
			body: serializer.encode(handshake('client-a')),
		})
		await server.handleHttpRequest({
			clientId: 'client-b',
			method: 'POST',
			contentType: 'application/json',
			body: serializer.encode(handshake('client-b')),
		})

		await drainPollQueue(server, 'client-a')
		await drainPollQueue(server, 'client-b')

		const op = createTestOp({ id: 'relay-op-1' })
		await server.handleHttpRequest({
			clientId: 'client-a',
			method: 'POST',
			contentType: 'application/json',
			body: serializer.encode({
				type: 'operation-batch',
				messageId: 'batch-1',
				operations: [op],
				isFinal: true,
				batchIndex: 0,
			}),
		})

		const relayed = await pollForMessage(server, serializer, 'client-b', (message) => {
			if (message.type !== 'operation-batch') return false
			return message.operations.some((operation) => operation.id === 'relay-op-1')
		})

		expect(relayed).toBeDefined()
	})
})

async function drainPollQueue(server: KoraSyncServer, clientId: string): Promise<void> {
	for (let index = 0; index < 10; index++) {
		const response = await server.handleHttpRequest({ clientId, method: 'GET' })
		if (response.status !== 200) {
			break
		}
	}
}

async function pollForMessage(
	server: KoraSyncServer,
	serializer: JsonMessageSerializer,
	clientId: string,
	matcher: (message: SyncMessage) => boolean,
): Promise<SyncMessage | null> {
	for (let index = 0; index < 20; index++) {
		const response = await server.handleHttpRequest({ clientId, method: 'GET' })
		if (response.status === 200) {
			const message = serializer.decode(response.body as string)
			if (matcher(message)) {
				return message
			}
		}

		await new Promise((resolve) => setTimeout(resolve, 5))
	}

	return null
}
