import type { Operation } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'
import type { AuthContext, AuthProvider } from '../types'
import { ClientSession } from './client-session'

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

function sendHandshake(
	client: ReturnType<typeof createServerTransportPair>['client'],
	overrides: Partial<SyncMessage & { type: 'handshake' }> = {},
): void {
	client.send({
		type: 'handshake',
		messageId: 'hs-1',
		nodeId: 'client-1',
		versionVector: {},
		schemaVersion: 1,
		supportedWireFormats: ['json', 'protobuf'],
		...overrides,
	})
}

function sendOpBatch(
	client: ReturnType<typeof createServerTransportPair>['client'],
	operations: Operation[],
	messageId = 'batch-1',
): void {
	client.send({
		type: 'operation-batch',
		messageId,
		operations: operations.map((op) => ({
			...op,
			timestamp: { ...op.timestamp },
			causalDeps: [...op.causalDeps],
		})),
		isFinal: true,
		batchIndex: 0,
	})
}

function collectClientMessages(
	client: ReturnType<typeof createServerTransportPair>['client'],
): SyncMessage[] {
	const messages: SyncMessage[] = []
	client.onMessage((msg) => messages.push(msg))
	return messages
}

describe('ClientSession', () => {
	describe('handshake', () => {
		test('responds with correct version vector', async () => {
			const store = new MemoryServerStore('server-1')
			// Pre-populate server store
			await store.applyRemoteOperation(
				createTestOp({ id: 'op-1', nodeId: 'node-a', sequenceNumber: 5 }),
			)

			const { client, server } = createServerTransportPair()
			const messages = collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
			})
			session.start()

			sendHandshake(client)

			// Wait for async handshake processing
			await vi.waitFor(() => {
				expect(messages.length).toBeGreaterThanOrEqual(1)
			})

			const response = messages[0]
			expect(response?.type).toBe('handshake-response')
			if (response?.type === 'handshake-response') {
				expect(response.accepted).toBe(true)
				expect(response.versionVector).toEqual({ 'node-a': 5 })
				expect(response.nodeId).toBe('server-1')
				expect(response.selectedWireFormat).toBe('protobuf')
			}
		})

		test('sends delta operations to client', async () => {
			const store = new MemoryServerStore('server-1')
			await store.applyRemoteOperation(
				createTestOp({ id: 'op-1', nodeId: 'node-a', sequenceNumber: 1 }),
			)
			await store.applyRemoteOperation(
				createTestOp({ id: 'op-2', nodeId: 'node-a', sequenceNumber: 2 }),
			)

			const { client, server } = createServerTransportPair()
			const messages = collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
			})
			session.start()

			// Client has no ops
			sendHandshake(client)

			await vi.waitFor(() => {
				const batches = messages.filter((m) => m.type === 'operation-batch')
				expect(batches.length).toBeGreaterThanOrEqual(1)
			})

			const batches = messages.filter((m) => m.type === 'operation-batch')
			const lastBatch = batches[batches.length - 1]
			if (lastBatch?.type === 'operation-batch') {
				expect(lastBatch.isFinal).toBe(true)
			}

			// Should contain the 2 operations
			const allOps = batches.flatMap((b) => (b.type === 'operation-batch' ? b.operations : []))
			expect(allOps).toHaveLength(2)
		})

		test('transitions to streaming after delta exchange', async () => {
			const store = new MemoryServerStore('server-1')
			const { client, server } = createServerTransportPair()
			const messages = collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
			})
			session.start()

			sendHandshake(client)

			await vi.waitFor(() => {
				expect(session.getState()).toBe('streaming')
			})

			expect(session.isStreaming()).toBe(true)
			expect(session.getClientNodeId()).toBe('client-1')
		})

		test('sends empty final batch when no delta', async () => {
			const store = new MemoryServerStore('server-1')
			const { client, server } = createServerTransportPair()
			const messages = collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
			})
			session.start()

			sendHandshake(client)

			await vi.waitFor(() => {
				expect(session.getState()).toBe('streaming')
			})

			const batches = messages.filter((m) => m.type === 'operation-batch')
			expect(batches).toHaveLength(1)
			if (batches[0]?.type === 'operation-batch') {
				expect(batches[0].operations).toHaveLength(0)
				expect(batches[0].isFinal).toBe(true)
			}
		})

		test('rejects duplicate handshake', async () => {
			const store = new MemoryServerStore('server-1')
			const { client, server } = createServerTransportPair()
			const messages = collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
			})
			session.start()

			sendHandshake(client)

			await vi.waitFor(() => {
				expect(session.getState()).toBe('streaming')
			})

			// Send second handshake
			sendHandshake(client, { messageId: 'hs-2' })

			await vi.waitFor(() => {
				const errors = messages.filter((m) => m.type === 'error')
				expect(errors.length).toBeGreaterThanOrEqual(1)
			})

			const errorMsg = messages.find((m) => m.type === 'error')
			if (errorMsg?.type === 'error') {
				expect(errorMsg.code).toBe('DUPLICATE_HANDSHAKE')
			}
		})
	})

	describe('authentication', () => {
		test('rejects when auth returns null', async () => {
			const store = new MemoryServerStore('server-1')
			const auth: AuthProvider = {
				authenticate: vi.fn().mockResolvedValue(null),
			}
			const { client, server } = createServerTransportPair()
			const messages = collectClientMessages(client)
			const onClose = vi.fn()

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
				auth,
				onClose,
			})
			session.start()

			sendHandshake(client, { authToken: 'bad-token' })

			await vi.waitFor(() => {
				expect(session.getState()).toBe('closed')
			})

			const errorMsg = messages.find((m) => m.type === 'error')
			expect(errorMsg).toBeDefined()
			if (errorMsg?.type === 'error') {
				expect(errorMsg.code).toBe('AUTH_FAILED')
			}
			expect(onClose).toHaveBeenCalledWith('sess-1')
		})

		test('sends ErrorMessage and closes on auth failure', async () => {
			const store = new MemoryServerStore('server-1')
			const auth: AuthProvider = {
				authenticate: vi.fn().mockResolvedValue(null),
			}
			const { client, server } = createServerTransportPair()
			const messages = collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
				auth,
			})
			session.start()

			sendHandshake(client)

			await vi.waitFor(() => {
				expect(session.getState()).toBe('closed')
			})

			// Should have received error message before close
			expect(messages.some((m) => m.type === 'error')).toBe(true)
		})

		test('accepts without auth provider', async () => {
			const store = new MemoryServerStore('server-1')
			const { client, server } = createServerTransportPair()
			const messages = collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
				// No auth provider
			})
			session.start()

			sendHandshake(client)

			await vi.waitFor(() => {
				expect(session.getState()).toBe('streaming')
			})

			expect(session.getAuthContext()).toBeNull()
		})

		test('stores auth context on successful authentication', async () => {
			const store = new MemoryServerStore('server-1')
			const authContext: AuthContext = { userId: 'user-1', metadata: { role: 'admin' } }
			const auth: AuthProvider = {
				authenticate: vi.fn().mockResolvedValue(authContext),
			}
			const { client, server } = createServerTransportPair()
			collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
				auth,
			})
			session.start()

			sendHandshake(client, { authToken: 'valid-token' })

			await vi.waitFor(() => {
				expect(session.getState()).toBe('streaming')
			})

			expect(session.getAuthContext()).toEqual(authContext)
		})
	})

	describe('operation batch', () => {
		test('applies operations to store', async () => {
			const store = new MemoryServerStore('server-1')
			const { client, server } = createServerTransportPair()
			collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
			})
			session.start()

			sendHandshake(client)
			await vi.waitFor(() => expect(session.getState()).toBe('streaming'))

			const op = createTestOp({ id: 'op-new', sequenceNumber: 1 })
			sendOpBatch(client, [op])

			await vi.waitFor(async () => {
				expect(await store.getOperationCount()).toBe(1)
			})

			expect(store.getAllOperations()[0]?.id).toBe('op-new')
		})

		test('sends acknowledgment with correct sequence number', async () => {
			const store = new MemoryServerStore('server-1')
			const { client, server } = createServerTransportPair()
			const messages = collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
			})
			session.start()

			sendHandshake(client)
			await vi.waitFor(() => expect(session.getState()).toBe('streaming'))

			const op = createTestOp({ id: 'op-1', sequenceNumber: 42 })
			sendOpBatch(client, [op], 'batch-42')

			await vi.waitFor(() => {
				const acks = messages.filter((m) => m.type === 'acknowledgment')
				expect(acks.length).toBeGreaterThanOrEqual(1)
			})

			const ack = messages.find(
				(m) =>
					m.type === 'acknowledgment' &&
					(m as { acknowledgedMessageId: string }).acknowledgedMessageId === 'batch-42',
			)
			expect(ack).toBeDefined()
			if (ack?.type === 'acknowledgment') {
				expect(ack.lastSequenceNumber).toBe(42)
			}
		})

		test('triggers onRelay for newly applied ops', async () => {
			const store = new MemoryServerStore('server-1')
			const onRelay = vi.fn()
			const { client, server } = createServerTransportPair()
			collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
				onRelay,
			})
			session.start()

			sendHandshake(client)
			await vi.waitFor(() => expect(session.getState()).toBe('streaming'))

			const op = createTestOp({ id: 'op-1', sequenceNumber: 1 })
			sendOpBatch(client, [op])

			await vi.waitFor(() => {
				expect(onRelay).toHaveBeenCalled()
			})

			expect(onRelay).toHaveBeenCalledWith('sess-1', [expect.objectContaining({ id: 'op-1' })])
		})

		test('does not relay duplicate operations', async () => {
			const store = new MemoryServerStore('server-1')
			// Pre-populate with op
			const existingOp = createTestOp({ id: 'op-1', sequenceNumber: 1 })
			await store.applyRemoteOperation(existingOp)

			const onRelay = vi.fn()
			const { client, server } = createServerTransportPair()
			collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
				onRelay,
			})
			session.start()

			sendHandshake(client, { versionVector: { 'client-1': 1 } })
			await vi.waitFor(() => expect(session.getState()).toBe('streaming'))

			// Send the same op that's already in the store
			sendOpBatch(client, [existingOp])

			// Wait a tick for processing
			await new Promise((r) => setTimeout(r, 50))

			expect(onRelay).not.toHaveBeenCalled()
		})
	})

	describe('relay', () => {
		test('sends batch to streaming client', async () => {
			const store = new MemoryServerStore('server-1')
			const { client, server } = createServerTransportPair()
			const messages = collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
			})
			session.start()

			sendHandshake(client)
			await vi.waitFor(() => expect(session.getState()).toBe('streaming'))

			const op = createTestOp({ id: 'relay-op', sequenceNumber: 1 })
			session.relayOperations([op])

			const relayed = messages.filter(
				(m) => m.type === 'operation-batch' && m.operations.some((o) => o.id === 'relay-op'),
			)
			expect(relayed).toHaveLength(1)
		})

		test('skips non-streaming session', () => {
			const store = new MemoryServerStore('server-1')
			const { client, server } = createServerTransportPair()
			const messages = collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
			})
			session.start()

			// Session is still 'connected', not 'streaming'
			const op = createTestOp({ id: 'relay-op' })
			session.relayOperations([op])

			const relayed = messages.filter(
				(m) => m.type === 'operation-batch' && m.operations.some((o) => o.id === 'relay-op'),
			)
			expect(relayed).toHaveLength(0)
		})

		test('skips disconnected transport', async () => {
			const store = new MemoryServerStore('server-1')
			const { client, server } = createServerTransportPair()
			const messages = collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
			})
			session.start()

			sendHandshake(client)
			await vi.waitFor(() => expect(session.getState()).toBe('streaming'))

			// Disconnect client
			client.disconnect()

			// Attempt relay — should not throw, should no-op
			const op = createTestOp({ id: 'relay-after-dc' })
			expect(() => session.relayOperations([op])).not.toThrow()
		})
	})

	describe('scopes', () => {
		test('delta only includes operations matching auth scope', async () => {
			const store = new MemoryServerStore('server-1')
			await store.applyRemoteOperation(
				createTestOp({
					id: 'todo-user-1',
					nodeId: 'node-a',
					sequenceNumber: 1,
					data: { ownerId: 'user-1', title: 'Mine' },
				}),
			)
			await store.applyRemoteOperation(
				createTestOp({
					id: 'todo-user-2',
					nodeId: 'node-a',
					sequenceNumber: 2,
					data: { ownerId: 'user-2', title: 'Not mine' },
				}),
			)

			const auth: AuthProvider = {
				authenticate: vi.fn().mockResolvedValue({
					userId: 'user-1',
					scopes: { todos: { ownerId: 'user-1' } },
				}),
			}

			const { client, server } = createServerTransportPair()
			const messages = collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
				auth,
			})
			session.start()

			sendHandshake(client, { authToken: 'ok' })

			await vi.waitFor(() => expect(session.getState()).toBe('streaming'))

			const batches = messages.filter((m) => m.type === 'operation-batch')
			const allIds = batches.flatMap((batch) =>
				batch.type === 'operation-batch' ? batch.operations.map((op) => op.id) : [],
			)
			expect(allIds).toContain('todo-user-1')
			expect(allIds).not.toContain('todo-user-2')
		})

		test('relay only sends operations matching auth scope', async () => {
			const store = new MemoryServerStore('server-1')
			const auth: AuthProvider = {
				authenticate: vi.fn().mockResolvedValue({
					userId: 'user-1',
					scopes: { todos: { ownerId: 'user-1' } },
				}),
			}

			const { client, server } = createServerTransportPair()
			const messages = collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
				auth,
			})
			session.start()

			sendHandshake(client, { authToken: 'ok' })
			await vi.waitFor(() => expect(session.getState()).toBe('streaming'))

			session.relayOperations([
				createTestOp({ id: 'visible', data: { ownerId: 'user-1', title: 'Mine' } }),
				createTestOp({ id: 'hidden', data: { ownerId: 'user-2', title: 'Not mine' } }),
			])

			await vi.waitFor(() => {
				const relayBatch = messages.find(
					(m) =>
						m.type === 'operation-batch' && m.operations.some((op) => op.id === 'visible'),
				)
				expect(relayBatch).toBeDefined()
			})

			const ids = messages
				.filter((m) => m.type === 'operation-batch')
				.flatMap((batch) => (batch.type === 'operation-batch' ? batch.operations.map((op) => op.id) : []))
			expect(ids).toContain('visible')
			expect(ids).not.toContain('hidden')
		})

		test('drops incoming out-of-scope operations', async () => {
			const store = new MemoryServerStore('server-1')
			const auth: AuthProvider = {
				authenticate: vi.fn().mockResolvedValue({
					userId: 'user-1',
					scopes: { todos: { ownerId: 'user-1' } },
				}),
			}
			const onRelay = vi.fn()

			const { client, server } = createServerTransportPair()
			const messages = collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
				auth,
				onRelay,
			})
			session.start()

			sendHandshake(client, { authToken: 'ok' })
			await vi.waitFor(() => expect(session.getState()).toBe('streaming'))

			sendOpBatch(client, [
				createTestOp({
					id: 'outside-scope',
					sequenceNumber: 1,
					data: { ownerId: 'user-2', title: 'Nope' },
				}),
			])

			await vi.waitFor(() => {
				const ack = messages.find(
					(m) =>
						m.type === 'acknowledgment' &&
						(m as { acknowledgedMessageId: string }).acknowledgedMessageId === 'batch-1',
				)
				expect(ack).toBeDefined()
			})

			expect(await store.getOperationCount()).toBe(0)
			expect(onRelay).not.toHaveBeenCalled()
		})
	})

	describe('close', () => {
		test('transitions to closed state', async () => {
			const store = new MemoryServerStore('server-1')
			const { client, server } = createServerTransportPair()
			collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
			})
			session.start()

			sendHandshake(client)
			await vi.waitFor(() => expect(session.getState()).toBe('streaming'))

			session.close('test close')
			expect(session.getState()).toBe('closed')
		})

		test('triggers onClose callback', async () => {
			const store = new MemoryServerStore('server-1')
			const onClose = vi.fn()
			const { client, server } = createServerTransportPair()
			collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
				onClose,
			})
			session.start()

			session.close()
			expect(onClose).toHaveBeenCalledWith('sess-1')
		})

		test('client disconnect triggers close', async () => {
			const store = new MemoryServerStore('server-1')
			const onClose = vi.fn()
			const { client, server } = createServerTransportPair()
			collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
				onClose,
			})
			session.start()

			sendHandshake(client)
			await vi.waitFor(() => expect(session.getState()).toBe('streaming'))

			client.disconnect()

			expect(session.getState()).toBe('closed')
			expect(onClose).toHaveBeenCalledWith('sess-1')
		})
	})

	describe('delta pagination', () => {
		test('large delta is paginated', async () => {
			const store = new MemoryServerStore('server-1')
			// Add 5 operations, use batchSize of 2
			for (let i = 1; i <= 5; i++) {
				await store.applyRemoteOperation(
					createTestOp({
						id: `op-${i}`,
						nodeId: 'node-a',
						sequenceNumber: i,
						timestamp: { wallTime: 1000 + i, logical: 0, nodeId: 'node-a' },
					}),
				)
			}

			const { client, server } = createServerTransportPair()
			const messages = collectClientMessages(client)

			const session = new ClientSession({
				sessionId: 'sess-1',
				transport: server,
				store,
				batchSize: 2,
			})
			session.start()

			sendHandshake(client)
			await vi.waitFor(() => expect(session.getState()).toBe('streaming'))

			const batches = messages.filter((m) => m.type === 'operation-batch')
			// 5 ops / batchSize 2 = 3 batches (2, 2, 1)
			expect(batches).toHaveLength(3)

			// Only last batch should be final
			for (let i = 0; i < batches.length; i++) {
				const batch = batches[i]
				if (batch?.type === 'operation-batch') {
					expect(batch.isFinal).toBe(i === batches.length - 1)
					expect(batch.batchIndex).toBe(i)
				}
			}
		})
	})
})
