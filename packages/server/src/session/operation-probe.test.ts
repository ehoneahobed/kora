/**
 * A client asks at handshake which of some operation ids the server stores
 * (`probeOperationIds`): the writes of a node its database retired, possibly shared with
 * another user's database (a beta.12 shared browser), whose version-vector entry cannot
 * tell this database's writes from the other's. Answered by id, only when the question is
 * well formed; never a partial answer the client could misread as "not stored".
 */
import { createOperation, defineSchema, t } from '@korajs/core'
import { HybridLogicalClock } from '@korajs/core'
import type { HandshakeResponseMessage, SyncMessage } from '@korajs/sync'
import { MAX_PROBE_OPERATION_IDS } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { KoraSyncServer } from '../server/kora-sync-server'
import { MemoryServerStore } from '../store/memory-server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { body: t.string() } } },
})

async function storedOperationIds(store: MemoryServerStore, count: number): Promise<string[]> {
	const clock = new HybridLogicalClock('shared-node')
	const ids: string[] = []
	for (let i = 1; i <= count; i++) {
		const op = await createOperation(
			{
				nodeId: 'shared-node',
				type: 'insert',
				collection: 'notes',
				recordId: `r${i}`,
				data: { body: `n${i}` },
				previousData: null,
				sequenceNumber: i,
				causalDeps: [],
				schemaVersion: 1,
			},
			clock,
		)
		await store.applyRemoteOperation(op)
		ids.push(op.id)
	}
	return ids
}

async function handshakeWith(
	server: KoraSyncServer,
	probeOperationIds: unknown,
): Promise<HandshakeResponseMessage> {
	const { client, server: transport } = createServerTransportPair()
	const messages: SyncMessage[] = []
	client.onMessage((m) => messages.push(m))
	server.handleConnection(transport)
	client.send({
		type: 'handshake',
		messageId: 'hs',
		nodeId: 'device-own',
		versionVector: {},
		schemaVersion: 1,
		protocolVersion: 2,
		sequenceReservation: true,
		lastDeliverySequence: 0,
		probeOperationIds,
	} as unknown as SyncMessage)
	await vi.waitFor(() => expect(messages.some((m) => m.type === 'handshake-response')).toBe(true))
	const response = messages.find((m) => m.type === 'handshake-response')
	if (!response || response.type !== 'handshake-response') throw new Error('no response')
	await client.disconnect()
	return response
}

async function setup(): Promise<{ server: KoraSyncServer; stored: string[] }> {
	const store = new MemoryServerStore()
	await store.setSchema(schema)
	const stored = await storedOperationIds(store, 3)
	const server = new KoraSyncServer({
		store,
		relayRetransmitIntervalMs: 0,
		deliveryPollIntervalMs: 0,
	})
	return { server, stored }
}

describe('handshake operation probe', () => {
	test('answers which asked ids the server stores', async () => {
		const { server, stored } = await setup()
		const unknown = 'f'.repeat(64)
		const response = await handshakeWith(server, [stored[0], unknown, stored[2]])
		expect(response.accepted).toBe(true)
		expect(response.operationProbe).toEqual({ stored: [stored[0], stored[2]] })
		await server.stop()
	})

	test('an empty answer is still an answer: none of the asked ids is stored', async () => {
		const { server } = await setup()
		const response = await handshakeWith(server, ['a'.repeat(64)])
		expect(response.operationProbe).toEqual({ stored: [] })
		await server.stop()
	})

	test('no question, an oversized one, or a malformed one gets no answer at all', async () => {
		const { server, stored } = await setup()
		for (const asked of [
			undefined,
			[],
			Array.from({ length: MAX_PROBE_OPERATION_IDS + 1 }, (_, i) => `${stored[0]}${i}`),
			[stored[0], 42],
			[stored[0], 'bad\u0000id'],
			'not-a-list',
		]) {
			const response = await handshakeWith(server, asked)
			expect(response.accepted).toBe(true)
			expect(response.operationProbe).toBeUndefined()
		}
		await server.stop()
	})
	test('a failed lookup omits the answer; the handshake is still accepted', async () => {
		const store = new MemoryServerStore()
		await store.setSchema(schema)
		const stored = await storedOperationIds(store, 1)
		store.findStoredOperations = vi.fn(async () => {
			throw new Error('database unavailable')
		})
		const server = new KoraSyncServer({
			store,
			relayRetransmitIntervalMs: 0,
			deliveryPollIntervalMs: 0,
		})
		const response = await handshakeWith(server, stored)
		expect(response.accepted).toBe(true)
		// No answer is never read as "not stored": the client re-authors nothing and asks again.
		expect(response.operationProbe).toBeUndefined()
		await server.stop()
	})
})
