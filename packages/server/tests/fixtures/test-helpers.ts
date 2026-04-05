import type { Operation, VersionVector } from '@korajs/core'
import type { ApplyResult, SyncMessage } from '@korajs/sync'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import type { AuthProvider, KoraSyncServerConfig } from '../../src/types'

/**
 * Create a chain of test operations from a single node.
 * Each operation causally depends on the previous one.
 */
export function createTestOperations(count: number, nodeId: string): Operation[] {
	const ops: Operation[] = []
	for (let i = 1; i <= count; i++) {
		ops.push({
			id: `${nodeId}-op-${i}`,
			nodeId,
			type: 'insert',
			collection: 'todos',
			recordId: `rec-${nodeId}-${i}`,
			data: { title: `Item ${i}` },
			previousData: null,
			timestamp: { wallTime: 1000 + i, logical: 0, nodeId },
			sequenceNumber: i,
			causalDeps: i > 1 ? [`${nodeId}-op-${i - 1}`] : [],
			schemaVersion: 1,
		})
	}
	return ops
}

/**
 * Simple in-memory SyncStore for the client side (used by integration tests
 * that manually implement the client protocol without SyncEngine).
 */
export class MockClientStore {
	private readonly nodeId: string
	private readonly operations: Operation[] = []
	private readonly operationIndex = new Map<string, Operation>()
	private readonly versionVector: Map<string, number> = new Map()

	constructor(nodeId: string) {
		this.nodeId = nodeId
	}

	getVersionVector(): VersionVector {
		return new Map(this.versionVector)
	}

	getNodeId(): string {
		return this.nodeId
	}

	async applyRemoteOperation(op: Operation): Promise<ApplyResult> {
		if (this.operationIndex.has(op.id)) return 'duplicate'

		this.operations.push(op)
		this.operationIndex.set(op.id, op)

		const currentSeq = this.versionVector.get(op.nodeId) ?? 0
		if (op.sequenceNumber > currentSeq) {
			this.versionVector.set(op.nodeId, op.sequenceNumber)
		}

		return 'applied'
	}

	async getOperationRange(nodeId: string, fromSeq: number, toSeq: number): Promise<Operation[]> {
		return this.operations
			.filter((op) => op.nodeId === nodeId && op.sequenceNumber >= fromSeq && op.sequenceNumber <= toSeq)
			.sort((a, b) => a.sequenceNumber - b.sequenceNumber)
	}

	getAllOperations(): Operation[] {
		return [...this.operations]
	}

	getOperationCount(): number {
		return this.operations.length
	}
}

/**
 * Set up a test server with helper methods for connecting clients.
 */
export function setupTestServer(
	configOverrides?: Partial<KoraSyncServerConfig>,
): {
	server: KoraSyncServer
	store: MemoryServerStore
	connectClient: (nodeId: string, initialOps?: Operation[]) => Promise<TestClient>
} {
	const store = new MemoryServerStore('server-1')
	const server = new KoraSyncServer({ store, ...configOverrides })

	async function connectClient(nodeId: string, initialOps?: Operation[]): Promise<TestClient> {
		const clientStore = new MockClientStore(nodeId)

		// Apply initial operations to client store
		if (initialOps) {
			for (const op of initialOps) {
				await clientStore.applyRemoteOperation(op)
			}
		}

		const { client, server: transport } = createServerTransportPair()
		const messages: SyncMessage[] = []
		client.onMessage((msg) => messages.push(msg))

		server.handleConnection(transport)

		return {
			nodeId,
			clientStore,
			client,
			serverTransport: transport,
			messages,
			async handshake(versionVector?: Record<string, number>) {
				const vv = versionVector ?? Object.fromEntries(clientStore.getVersionVector())
				client.send({
					type: 'handshake',
					messageId: `hs-${nodeId}`,
					nodeId,
					versionVector: vv,
					schemaVersion: 1,
				})
			},
			async waitForStreaming() {
				return new Promise<void>((resolve, reject) => {
					const timeout = setTimeout(() => reject(new Error('Timed out waiting for streaming')), 5000)
					const check = () => {
						const response = messages.find((m) => m.type === 'handshake-response')
						const finalBatch = messages.find(
							(m) => m.type === 'operation-batch' && m.isFinal,
						)
						if (response && finalBatch) {
							clearTimeout(timeout)
							resolve()
						} else {
							setTimeout(check, 10)
						}
					}
					check()
				})
			},
			getReceivedOperations(): Operation[] {
				const ops: Operation[] = []
				for (const msg of messages) {
					if (msg.type === 'operation-batch') {
						// These are SerializedOperations, but since we use JSON they're identical to Operations
						for (const sop of msg.operations) {
							ops.push(sop as unknown as Operation)
						}
					}
				}
				return ops
			},
			sendOps(ops: Operation[]) {
				client.send({
					type: 'operation-batch',
					messageId: `batch-${nodeId}-${Date.now()}`,
					operations: ops.map((op) => ({
						...op,
						timestamp: { ...op.timestamp },
						causalDeps: [...op.causalDeps],
					})),
					isFinal: true,
					batchIndex: 0,
				})
			},
			disconnect() {
				client.disconnect()
			},
		}
	}

	return { server, store, connectClient }
}

export interface TestClient {
	nodeId: string
	clientStore: MockClientStore
	client: ReturnType<typeof createServerTransportPair>['client']
	serverTransport: ReturnType<typeof createServerTransportPair>['server']
	messages: SyncMessage[]
	handshake(versionVector?: Record<string, number>): Promise<void>
	waitForStreaming(): Promise<void>
	getReceivedOperations(): Operation[]
	sendOps(ops: Operation[]): void
	disconnect(): void
}
