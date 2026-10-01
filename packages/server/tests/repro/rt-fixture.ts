/**
 * Shared harness for the Phase 1 red-team reproductions (RT-n). Real KoraSyncServer,
 * real ClientSession, in-memory transports.
 */
import type { Operation, SchemaDefinition } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { expect, vi } from 'vitest'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'
import type { AuthProvider, KoraSyncServerConfig } from '../../src/types'

export interface TestClient {
	client: ReturnType<typeof createServerTransportPair>['client']
	messages: SyncMessage[]
	send: (message: SyncMessage) => void
}

export interface Harness {
	store: MemoryServerStore
	server: KoraSyncServer
	connect: () => TestClient
	login: (token: string, nodeId: string, extra?: Partial<SyncMessage>) => Promise<TestClient>
}

export async function createHarness(
	schema: SchemaDefinition,
	auth: AuthProvider | null,
	extra: Partial<KoraSyncServerConfig> = {},
	store: MemoryServerStore = new MemoryServerStore('server-1'),
): Promise<Harness> {
	await store.setSchema(schema)
	const server = new KoraSyncServer({
		store,
		...(auth ? { auth } : {}),
		relayRetransmitIntervalMs: 0,
		deliveryPollIntervalMs: 0,
		...extra,
	})
	const connect = (): TestClient => {
		const { client, server: transport } = createServerTransportPair()
		const messages: SyncMessage[] = []
		client.onMessage((m) => messages.push(m))
		server.handleConnection(transport)
		return {
			client,
			messages,
			send: (message) => {
				try {
					client.send(message)
				} catch {
					// The server may already have closed this connection.
				}
			},
		}
	}
	const login = async (
		token: string,
		nodeId: string,
		extraHandshake: Partial<SyncMessage> = {},
	): Promise<TestClient> => {
		const c = connect()
		c.send({
			type: 'handshake',
			messageId: `hs-${nodeId}-${Math.random()}`,
			nodeId,
			versionVector: {},
			schemaVersion: schema.version,
			authToken: token,
			...extraHandshake,
		} as SyncMessage)
		await vi.waitFor(() =>
			expect(c.messages.some((m) => m.type === 'handshake-response' || m.type === 'error')).toBe(
				true,
			),
		)
		// Let the initial stream land before the test acts.
		await tick()
		return c
	}
	return { store, server, connect, login }
}

export const tick = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let counter = 0
/** A well-formed client operation authored by `nodeId`. */
export function makeOp(
	nodeId: string,
	sequenceNumber: number,
	overrides: Partial<Operation>,
): Operation {
	counter += 1
	return {
		id: `rt-op-${nodeId}-${sequenceNumber}-${counter}`,
		nodeId,
		type: 'insert',
		collection: 'notes',
		recordId: `rt-rec-${counter}`,
		data: {},
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: counter, nodeId },
		sequenceNumber,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

export function batch(ops: Operation[], messageId = `b-${Math.random()}`): SyncMessage {
	return { type: 'operation-batch', messageId, operations: ops, isFinal: true, batchIndex: 0 }
}

/** Every operation id delivered to a client in operation batches so far. */
export function deliveredOpIds(messages: SyncMessage[]): string[] {
	const ids: string[] = []
	for (const m of messages) {
		if (m.type !== 'operation-batch') continue
		for (const op of m.operations as Operation[]) ids.push(op.id)
	}
	return ids
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
