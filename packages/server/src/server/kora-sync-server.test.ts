import { type Operation, defineSchema, generateUUIDv7, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { encodeYjsUpdate } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'
import { KoraSyncServer } from './kora-sync-server'

function createTestOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: `op-${Math.random().toString(36).slice(2)}`,
		nodeId: 'client-1',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'test' },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'client-1' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

function collectClientMessages(
	client: ReturnType<typeof createServerTransportPair>['client'],
): SyncMessage[] {
	const messages: SyncMessage[] = []
	client.onMessage((msg) => messages.push(msg))
	return messages
}

function sendHandshake(
	client: ReturnType<typeof createServerTransportPair>['client'],
	nodeId = 'client-1',
	versionVector: Record<string, number> = {},
): void {
	client.send({
		type: 'handshake',
		messageId: `hs-${nodeId}`,
		nodeId,
		versionVector,
		schemaVersion: 1,
	})
}

describe('KoraSyncServer', () => {
	test('handleConnection creates a session and returns sessionId', () => {
		const store = new MemoryServerStore('server-1')
		const server = new KoraSyncServer({ store })
		const { server: transport } = createServerTransportPair()

		const sessionId = server.handleConnection(transport)
		expect(sessionId).toBeTruthy()
		expect(server.getConnectionCount()).toBe(1)
	})

	test('rejects when maxConnections reached', () => {
		const store = new MemoryServerStore('server-1')
		const server = new KoraSyncServer({ store, maxConnections: 1 })

		const { server: t1 } = createServerTransportPair()
		server.handleConnection(t1)

		const { server: t2 } = createServerTransportPair()
		expect(() => server.handleConnection(t2)).toThrow('Maximum connections reached')
		expect(server.getConnectionCount()).toBe(1)
	})

	test('getStatus returns correct status', async () => {
		const store = new MemoryServerStore('server-1')
		await store.applyRemoteOperation(createTestOp({ id: 'op-1' }))

		const server = new KoraSyncServer({ store, port: 3000 })
		const { server: transport } = createServerTransportPair()
		server.handleConnection(transport)

		const status = await server.getStatus()
		expect(status.running).toBe(false) // Not started in standalone mode
		expect(status.connectedClients).toBe(1)
		expect(status.port).toBe(3000)
		expect(status.totalOperations).toBe(1)
	})

	test('getConnectionCount reflects active sessions', () => {
		const store = new MemoryServerStore('server-1')
		const server = new KoraSyncServer({ store })

		expect(server.getConnectionCount()).toBe(0)

		const { server: t1 } = createServerTransportPair()
		server.handleConnection(t1)
		expect(server.getConnectionCount()).toBe(1)

		const { server: t2 } = createServerTransportPair()
		server.handleConnection(t2)
		expect(server.getConnectionCount()).toBe(2)
	})

	test('session close removes from sessions map', async () => {
		const store = new MemoryServerStore('server-1')
		const server = new KoraSyncServer({ store })

		const { client, server: transport } = createServerTransportPair()
		collectClientMessages(client)
		server.handleConnection(transport)
		expect(server.getConnectionCount()).toBe(1)

		// Disconnect client → triggers session close
		client.disconnect()
		expect(server.getConnectionCount()).toBe(0)
	})

	test('relay sends operations from session A to session B', async () => {
		const store = new MemoryServerStore('server-1')
		const server = new KoraSyncServer({ store })

		// Connect client A
		const pairA = createServerTransportPair()
		const messagesA = collectClientMessages(pairA.client)
		server.handleConnection(pairA.server)

		// Connect client B
		const pairB = createServerTransportPair()
		const messagesB = collectClientMessages(pairB.client)
		server.handleConnection(pairB.server)

		// Both clients handshake
		sendHandshake(pairA.client, 'client-a')
		sendHandshake(pairB.client, 'client-b')

		// Wait for both to be streaming
		await vi.waitFor(() => {
			const responseA = messagesA.find((m) => m.type === 'handshake-response')
			const responseB = messagesB.find((m) => m.type === 'handshake-response')
			expect(responseA).toBeDefined()
			expect(responseB).toBeDefined()
		})

		// Wait for streaming state (both should get delta batches)
		await vi.waitFor(() => {
			const batchesA = messagesA.filter((m) => m.type === 'operation-batch')
			const batchesB = messagesB.filter((m) => m.type === 'operation-batch')
			expect(batchesA.length).toBeGreaterThanOrEqual(1)
			expect(batchesB.length).toBeGreaterThanOrEqual(1)
		})

		// Client A sends an operation
		const op = createTestOp({ id: 'op-from-a', nodeId: 'client-a', sequenceNumber: 1 })
		pairA.client.send({
			type: 'operation-batch',
			messageId: 'batch-from-a',
			operations: [
				{
					...op,
					timestamp: { ...op.timestamp },
					causalDeps: [...op.causalDeps],
				},
			],
			isFinal: true,
			batchIndex: 0,
		})

		// Client B should receive the relayed operation
		await vi.waitFor(() => {
			const relayed = messagesB.filter(
				(m) => m.type === 'operation-batch' && m.operations.some((o) => o.id === 'op-from-a'),
			)
			expect(relayed.length).toBeGreaterThanOrEqual(1)
		})

		// Client A should NOT receive its own operation back
		const relayedToA = messagesA.filter(
			(m) => m.type === 'operation-batch' && m.operations.some((o) => o.id === 'op-from-a'),
		)
		expect(relayedToA).toHaveLength(0)
	})

	test('relays yjs-doc-update from session A to session B', async () => {
		const store = new MemoryServerStore('server-1')
		const server = new KoraSyncServer({ store })

		const pairA = createServerTransportPair()
		const messagesA = collectClientMessages(pairA.client)
		server.handleConnection(pairA.server)

		const pairB = createServerTransportPair()
		const messagesB = collectClientMessages(pairB.client)
		server.handleConnection(pairB.server)

		sendHandshake(pairA.client, 'client-a')
		sendHandshake(pairB.client, 'client-b')

		await vi.waitFor(() => {
			expect(messagesA.some((m) => m.type === 'handshake-response')).toBe(true)
			expect(messagesB.some((m) => m.type === 'handshake-response')).toBe(true)
		})

		const update = encodeYjsUpdate(new Uint8Array([1, 2, 3]))
		pairA.client.send({
			type: 'yjs-doc-update',
			messageId: generateUUIDv7(),
			collection: 'articles',
			recordId: 'rec-1',
			field: 'body',
			update,
		})

		await vi.waitFor(() => {
			expect(
				messagesB.some(
					(m) => m.type === 'yjs-doc-update' && m.collection === 'articles' && m.update === update,
				),
			).toBe(true)
		})

		expect(messagesA.filter((m) => m.type === 'yjs-doc-update')).toHaveLength(0)
	})

	test('relay only sends to streaming sessions', async () => {
		const store = new MemoryServerStore('server-1')
		const server = new KoraSyncServer({ store })

		// Connect client A (will handshake)
		const pairA = createServerTransportPair()
		collectClientMessages(pairA.client)
		server.handleConnection(pairA.server)

		// Connect client B (will NOT handshake — stays in 'connected' state)
		const pairB = createServerTransportPair()
		const messagesB = collectClientMessages(pairB.client)
		server.handleConnection(pairB.server)

		// Only A handshakes
		sendHandshake(pairA.client, 'client-a')

		await vi.waitFor(() => {
			// Wait some time for A's handshake to complete
			return new Promise((r) => setTimeout(r, 100))
		})

		// A sends an op
		const op = createTestOp({ id: 'op-from-a', nodeId: 'client-a', sequenceNumber: 1 })
		pairA.client.send({
			type: 'operation-batch',
			messageId: 'batch-from-a',
			operations: [
				{
					...op,
					timestamp: { ...op.timestamp },
					causalDeps: [...op.causalDeps],
				},
			],
			isFinal: true,
			batchIndex: 0,
		})

		// B should NOT receive the operation (not streaming)
		await new Promise((r) => setTimeout(r, 100))
		const relayed = messagesB.filter(
			(m) => m.type === 'operation-batch' && m.operations.some((o) => o.id === 'op-from-a'),
		)
		expect(relayed).toHaveLength(0)
	})

	test('stop closes all sessions', async () => {
		const store = new MemoryServerStore('server-1')
		const server = new KoraSyncServer({ store })

		const { client: c1, server: t1 } = createServerTransportPair()
		const { client: c2, server: t2 } = createServerTransportPair()
		collectClientMessages(c1)
		collectClientMessages(c2)

		server.handleConnection(t1)
		server.handleConnection(t2)
		expect(server.getConnectionCount()).toBe(2)

		await server.stop()
		expect(server.getConnectionCount()).toBe(0)
	})

	describe('server-config operation limits reach the session', () => {
		test('maxOpsPerMinute set at server config rate-limits a connected client', async () => {
			const store = new MemoryServerStore('server-rate')
			const server = new KoraSyncServer({ store, maxOpsPerMinute: 1 })

			const { client, server: transport } = createServerTransportPair()
			const messages = collectClientMessages(client)
			server.handleConnection(transport)

			sendHandshake(client, 'client-rate')
			await vi.waitFor(() => {
				expect(messages.find((m) => m.type === 'handshake-response')).toBeDefined()
			})

			// Two ops in one batch: the first is allowed, the second trips the
			// per-minute limit of 1 and comes back as a retriable RATE_LIMIT error.
			const op1 = createTestOp({ id: 'rate-1', nodeId: 'client-rate', recordId: 'r1' })
			const op2 = createTestOp({ id: 'rate-2', nodeId: 'client-rate', recordId: 'r2' })
			client.send({
				type: 'operation-batch',
				messageId: 'rate-batch',
				operations: [op1, op2].map((op) => ({
					...op,
					timestamp: { ...op.timestamp },
					causalDeps: [...op.causalDeps],
				})),
				isFinal: true,
				batchIndex: 0,
			})

			await vi.waitFor(() => {
				const err = messages.find((m) => m.type === 'error' && m.code === 'RATE_LIMIT')
				expect(err).toBeDefined()
			})
			const err = messages.find((m) => m.type === 'error' && m.code === 'RATE_LIMIT')
			if (err?.type === 'error') {
				expect(err.retriable).toBe(true)
			}

			await server.stop()
		})

		test('maxOperationBytes set at server config rejects an oversized op', async () => {
			const store = new MemoryServerStore('server-size')
			const server = new KoraSyncServer({ store, maxOperationBytes: 64 })

			const { client, server: transport } = createServerTransportPair()
			const messages = collectClientMessages(client)
			server.handleConnection(transport)

			sendHandshake(client, 'client-size')
			await vi.waitFor(() => {
				expect(messages.find((m) => m.type === 'handshake-response')).toBeDefined()
			})

			// A payload well past the 64-byte cap: rejected as a permanent
			// OPERATION_TOO_LARGE (resending the same bytes can never fit).
			const big = createTestOp({
				id: 'big-1',
				nodeId: 'client-size',
				recordId: 'big',
				data: { title: 'x'.repeat(500) },
			})
			client.send({
				type: 'operation-batch',
				messageId: 'size-batch',
				operations: [{ ...big, timestamp: { ...big.timestamp }, causalDeps: [...big.causalDeps] }],
				isFinal: true,
				batchIndex: 0,
			})

			await vi.waitFor(() => {
				const err = messages.find((m) => m.type === 'error' && m.code === 'OPERATION_TOO_LARGE')
				expect(err).toBeDefined()
			})
			const err = messages.find((m) => m.type === 'error' && m.code === 'OPERATION_TOO_LARGE')
			if (err?.type === 'error') {
				expect(err.retriable).toBe(false)
			}

			await server.stop()
		})
	})

	describe('server-side operation validation', () => {
		const schema = defineSchema({
			version: 1,
			collections: { submissions: { fields: { text: t.string() } } },
		})

		function submissionOp(id: string, text: string): Operation {
			return createTestOp({
				id,
				nodeId: 'client-sub',
				collection: 'submissions',
				recordId: id,
				data: { text },
			})
		}

		async function connectStreaming(server: KoraSyncServer) {
			const { client, server: transport } = createServerTransportPair()
			const messages = collectClientMessages(client)
			server.handleConnection(transport)
			sendHandshake(client, 'client-sub')
			await vi.waitFor(() => {
				expect(messages.find((m) => m.type === 'handshake-response')).toBeDefined()
			})
			return { client, messages }
		}

		function sendOp(client: ReturnType<typeof createServerTransportPair>['client'], op: Operation) {
			client.send({
				type: 'operation-batch',
				messageId: `batch-${op.id}`,
				operations: [{ ...op, timestamp: { ...op.timestamp }, causalDeps: [...op.causalDeps] }],
				isFinal: true,
				batchIndex: 0,
			})
		}

		test('accept lets the operation materialize', async () => {
			const store = new MemoryServerStore('server-accept')
			await store.setSchema(schema)
			const server = new KoraSyncServer({ store, validateOperation: () => ({ action: 'accept' }) })

			const { client } = await connectStreaming(server)
			sendOp(client, submissionOp('accept-1', 'hello'))

			await vi.waitFor(async () => {
				const rows = await store.materializeCollection('submissions')
				expect(rows).toHaveLength(1)
			})
			await server.stop()
		})

		test('reject sends operation-rejected tied to the op id and never materializes', async () => {
			const store = new MemoryServerStore('server-reject')
			await store.setSchema(schema)
			const server = new KoraSyncServer({
				store,
				validateOperation: (op) => {
					// Policy: the submitter passed the incoming op; anonymous auth is null.
					expect(op.collection).toBe('submissions')
					return { action: 'reject', code: 'WINDOW_CLOSED', message: 'Submissions are closed' }
				},
			})

			const { client, messages } = await connectStreaming(server)
			const op = submissionOp('reject-1', 'too late')
			sendOp(client, op)

			await vi.waitFor(() => {
				expect(messages.find((m) => m.type === 'operation-rejected')).toBeDefined()
			})
			const rejected = messages.find((m) => m.type === 'operation-rejected')
			if (rejected?.type === 'operation-rejected') {
				expect(rejected.operationId).toBe(op.id)
				expect(rejected.collection).toBe('submissions')
				expect(rejected.recordId).toBe(op.recordId)
				expect(rejected.code).toBe('WINDOW_CLOSED')
				// Unknown code defaults to permanent via the shared taxonomy.
				expect(rejected.retriable).toBe(false)
			}

			// The rejected op never entered the authoritative log.
			const rows = await store.materializeCollection('submissions')
			expect(rows).toHaveLength(0)
			await server.stop()
		})

		test('a validator can author a derived op and ignore the raw submission', async () => {
			const store = new MemoryServerStore('server-derive')
			await store.setSchema(
				defineSchema({
					version: 1,
					collections: {
						submissions: { fields: { text: t.string() } },
						formResponses: { fields: { answer: t.string() } },
					},
				}),
			)
			const server = new KoraSyncServer({
				store,
				validateOperation: async (op, ctx) => {
					// Promote the anonymous submission into the owner-visible collection
					// as a NEW server-authored op, then ignore the raw one.
					await ctx.kora.apply({
						collection: 'formResponses',
						type: 'insert',
						data: { answer: (op.data as { text: string }).text },
					})
					return { action: 'ignore' }
				},
			})

			const { client, messages } = await connectStreaming(server)
			sendOp(client, submissionOp('derive-1', 'my answer'))

			await vi.waitFor(async () => {
				const owner = await store.materializeCollection('formResponses')
				expect(owner).toHaveLength(1)
			})
			const owner = await store.materializeCollection('formResponses')
			expect(owner[0]?.answer).toBe('my answer')
			// The raw submission was ignored: not materialized, and no rejection sent.
			const raw = await store.materializeCollection('submissions')
			expect(raw).toHaveLength(0)
			expect(messages.find((m) => m.type === 'operation-rejected')).toBeUndefined()
			await server.stop()
		})
	})
})
