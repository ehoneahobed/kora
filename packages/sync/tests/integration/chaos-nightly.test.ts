import type { Operation } from '@kora/core'
import { describe, expect, test } from 'vitest'
import { SyncEngine } from '../../src/engine/sync-engine'
import type {
	AcknowledgmentMessage,
	HandshakeMessage,
	HandshakeResponseMessage,
	OperationBatchMessage,
	SyncMessage,
} from '../../src/protocol/messages'
import { JsonMessageSerializer } from '../../src/protocol/serializer'
import { ChaosTransport } from '../../src/transport/chaos-transport'
import type { MemoryTransport } from '../../src/transport/memory-transport'
import { createMemoryTransportPair } from '../../src/transport/memory-transport'
import {
	createMockSyncStore,
	createTestOperations,
} from '../fixtures/test-helpers'

const serializer = new JsonMessageSerializer()

const CLIENT_COUNT = 10
const OPERATIONS_PER_CLIENT = 1000
const EXPECTED_TOTAL_OPERATIONS = CLIENT_COUNT * OPERATIONS_PER_CLIENT
const MAX_SYNC_ROUNDS = 30
const MAX_CONVERGENCE_TIME_MS = 60_000

class ChaosHub {
	private readonly store = createMockSyncStore({ nodeId: 'hub' })
	private readonly clientTransports = new Map<string, MemoryTransport>()

	createClientTransport(clientId: string): { client: MemoryTransport; server: MemoryTransport } {
		const { client, server } = createMemoryTransportPair()
		this.clientTransports.set(clientId, server)
		this.setupServerHandler(clientId, server)
		return { client, server }
	}

	getStore(): ReturnType<typeof createMockSyncStore> {
		return this.store
	}

	private setupServerHandler(clientId: string, server: MemoryTransport): void {
		server.onMessage((message: SyncMessage) => {
			if (message.type === 'handshake') {
				void this.handleHandshake(message, server)
				return
			}

			if (message.type === 'operation-batch') {
				void this.handleBatch(message, clientId, server)
			}
		})
	}

	private async handleHandshake(message: HandshakeMessage, server: MemoryTransport): Promise<void> {
		const response: HandshakeResponseMessage = {
			type: 'handshake-response',
			messageId: `resp-${message.messageId}`,
			nodeId: 'hub',
			versionVector: Object.fromEntries(this.store.getVersionVector()),
			schemaVersion: message.schemaVersion,
			accepted: true,
		}
		safeSend(server, response)

		const clientVector = new Map(
			Object.entries(message.versionVector).map(([nodeId, sequence]) => [nodeId, sequence as number]),
		)

		const missing: Operation[] = []
		for (const [nodeId, hubSequence] of this.store.getVersionVector()) {
			const clientSequence = clientVector.get(nodeId) ?? 0
			if (hubSequence > clientSequence) {
				const operations = await this.store.getOperationRange(nodeId, clientSequence + 1, hubSequence)
				missing.push(...operations)
			}
		}

		const delta: OperationBatchMessage = {
			type: 'operation-batch',
			messageId: `delta-${Date.now()}-${Math.random()}`,
			operations: missing.map((operation) => serializer.encodeOperation(operation)),
			isFinal: true,
			batchIndex: 0,
		}
		safeSend(server, delta)
	}

	private async handleBatch(
		message: OperationBatchMessage,
		sourceClientId: string,
		server: MemoryTransport,
	): Promise<void> {
		const operations = message.operations.map((operation) => serializer.decodeOperation(operation))
		const applied: Operation[] = []

		for (const operation of operations) {
			const result = await this.store.applyRemoteOperation(operation)
			if (result === 'applied') {
				applied.push(operation)
			}
		}

		const lastOperation = operations[operations.length - 1]
		const acknowledgement: AcknowledgmentMessage = {
			type: 'acknowledgment',
			messageId: `ack-${message.messageId}`,
			acknowledgedMessageId: message.messageId,
			lastSequenceNumber: lastOperation ? lastOperation.sequenceNumber : 0,
		}
		safeSend(server, acknowledgement)

		if (applied.length === 0) {
			return
		}

		for (const [clientId, transport] of this.clientTransports) {
			if (clientId === sourceClientId || !transport.isConnected()) {
				continue
			}

			const relay: OperationBatchMessage = {
				type: 'operation-batch',
				messageId: `relay-${Date.now()}-${Math.random()}`,
				operations: applied.map((operation) => serializer.encodeOperation(operation)),
				isFinal: true,
				batchIndex: 0,
			}
			safeSend(transport, relay)
		}
	}
}

describe('Chaos Nightly Convergence', () => {
	test(
		'10 clients × 1,000 ops converge within 60s under 10% drop and 5% duplicate',
		async () => {
			const startedAt = Date.now()
			const hub = new ChaosHub()

			const clients = Array.from({ length: CLIENT_COUNT }, (_, index) => {
				const nodeId = `node-${index}`
				return {
					clientId: `client-${index}`,
					nodeId,
					store: createMockSyncStore({
						nodeId,
						initialOps: createTestOperations(OPERATIONS_PER_CLIENT, nodeId),
					}),
				}
			})

			for (let round = 0; round < MAX_SYNC_ROUNDS; round++) {
				await Promise.all(
					clients.map((client) =>
						runChaosSyncAttempt(hub, client.clientId, client.store),
					),
				)

				if (isFullyConverged(hub, clients)) {
					break
				}

				if (Date.now() - startedAt > MAX_CONVERGENCE_TIME_MS) {
					break
				}
			}

			const elapsedMs = Date.now() - startedAt
			expect(elapsedMs).toBeLessThanOrEqual(MAX_CONVERGENCE_TIME_MS)

			expect(hub.getStore().getAllOperations()).toHaveLength(EXPECTED_TOTAL_OPERATIONS)

			const hubIds = new Set(hub.getStore().getAllOperations().map((operation) => operation.id))
			for (const client of clients) {
				const operations = client.store.getAllOperations()
				expect(operations).toHaveLength(EXPECTED_TOTAL_OPERATIONS)
				expect(new Set(operations.map((operation) => operation.id))).toEqual(hubIds)
			}
		},
		70_000,
	)
})

function isFullyConverged(
	hub: ChaosHub,
	clients: Array<{ store: ReturnType<typeof createMockSyncStore> }>,
): boolean {
	if (hub.getStore().getAllOperations().length !== EXPECTED_TOTAL_OPERATIONS) {
		return false
	}

	for (const client of clients) {
		if (client.store.getAllOperations().length !== EXPECTED_TOTAL_OPERATIONS) {
			return false
		}
	}

	return true
}

async function runChaosSyncAttempt(
	hub: ChaosHub,
	clientId: string,
	store: ReturnType<typeof createMockSyncStore>,
): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const { client } = hub.createClientTransport(clientId)
		const transport = new ChaosTransport(client, {
			dropRate: 0.1,
			duplicateRate: 0.05,
			reorderRate: 0,
			maxLatency: 25,
			randomSource: Math.random,
		})

		const engine = new SyncEngine({
			transport,
			store,
			config: { url: 'ws://chaos-nightly', batchSize: 1000 },
		})

		try {
			await engine.start()
			const reachedStreaming = await waitForStreaming(engine, 600)

			if (!reachedStreaming) {
				continue
			}

			const flushStartedAt = Date.now()
			while (engine.getStatus().pendingOperations > 0 && Date.now() - flushStartedAt < 800) {
				await sleep(25)
			}

			return
		} finally {
			await engine.stop()
		}
	}
}

async function waitForStreaming(engine: SyncEngine, timeoutMs: number): Promise<boolean> {
	const startedAt = Date.now()

	while (Date.now() - startedAt < timeoutMs) {
		if (engine.getState() === 'streaming') {
			return true
		}
		await sleep(25)
	}

	return false
}

function safeSend(transport: MemoryTransport, message: SyncMessage): void {
	if (!transport.isConnected()) {
		return
	}

	try {
		transport.send(message)
	} catch {
		// Ignore races with disconnect during chaos retries.
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
