import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { PostgresServerStore } from '../../src/store/postgres-server-store'
import type { ServerStore } from '../../src/store/server-store'
import { createSqliteServerStore } from '../../src/store/sqlite-server-store'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'
/**
 * RT-48 repro (Phase 2 red team round 2, 2026-10-02): the second op of an RT-37 legacy
 * pair never reaches a version-vector client (no delivery watermark: Kora <= beta.12,
 * and any client that falls back to the vector delta) that already holds the first one.
 *
 * The legacy writer's pair shares (node, seq). A vector client that received X@(W, 1)
 * reports W:1 at its next handshake; `collectDeltaOperations` asks
 * `getOperationRange(W, 2, max)`, which can never return Y@(W, 1). Before Phase 2 the
 * pair could only come from beta.12 history (pre-epoch); since RT-37 the server keeps
 * creating new pairs for every beta.12 writer, so mixed fleets diverge permanently on
 * the vector clients. The live relay only covers a peer that happens to be connected.
 *
 * Asserts the CORRECT behaviour (fails today on every store): the vector client gets Y.
 */
import { withContentId } from '../fixtures/content-id'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string() } } },
})

let cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const fn of cleanups.reverse()) await fn()
	cleanups = []
})

// Waits are on observable state, never on a fixed sleep: a Postgres commit under CPU load
// takes longer than any sleep that is short enough to keep the suite fast.
const WAIT = { timeout: 15_000, interval: 10 }

let counter = 0
function makeOp(nodeId: string, sequenceNumber: number, title: string): Operation {
	counter += 1
	// A real content-addressed id: the server verifies it (RT-64).
	return withContentId({
		id: `rt48-op-${nodeId}-${sequenceNumber}-${counter}`,
		nodeId,
		type: 'insert',
		collection: 'notes',
		recordId: `rt48-rec-${counter}`,
		data: { title },
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: counter, nodeId },
		sequenceNumber,
		causalDeps: [],
		schemaVersion: 1,
	})
}

let pgSchemas = 0
async function openStore(kind: 'memory' | 'sqlite' | 'postgres'): Promise<ServerStore> {
	if (kind === 'memory') return new MemoryServerStore('server-1')
	if (kind === 'sqlite')
		return createSqliteServerStore({ filename: ':memory:', nodeId: 'server-1' })
	const url = process.env.KORA_PG_TEST_URL as string
	pgSchemas += 1
	const name = `kora_rt48_${process.pid}_${pgSchemas}`
	const admin = postgres(url, { max: 1, onnotice: () => {} })
	await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
	await admin.unsafe(`CREATE SCHEMA ${name}`)
	const client = postgres(url, {
		max: 4,
		idle_timeout: 1,
		onnotice: () => {},
		connection: { search_path: name },
	})
	cleanups.push(async () => {
		await client.end()
		await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
		await admin.end()
	})
	return new PostgresServerStore(drizzle(client), 'server-1')
}

const kinds = [
	'memory',
	'sqlite',
	...(process.env.KORA_PG_TEST_URL ? (['postgres'] as const) : []),
] as const

describe.each(kinds)('RT-48: legacy pair vs version-vector clients (%s store)', (kind) => {
	test('a vector client holding the first op of a pair receives the second', async () => {
		const store = await openStore(kind)
		await store.setSchema(schema)
		const server = new KoraSyncServer({
			store,
			relayRetransmitIntervalMs: 0,
			deliveryPollIntervalMs: 0,
		})
		cleanups.push(async () => {
			await server.stop()
		})
		const login = async (nodeId: string, handshake: Record<string, unknown> = {}) => {
			const { client, server: transport } = createServerTransportPair()
			const messages: SyncMessage[] = []
			client.onMessage((m) => messages.push(m))
			server.handleConnection(transport)
			const send = (message: SyncMessage): void => client.send(message)
			send({
				type: 'handshake',
				messageId: `hs-${nodeId}-${Math.random()}`,
				nodeId,
				versionVector: {},
				schemaVersion: schema.version,
				...handshake,
			} as SyncMessage)
			await vi.waitFor(
				() => expect(messages.some((m) => m.type === 'handshake-response')).toBe(true),
				WAIT,
			)
			return { messages, send, close: () => void client.disconnect() }
		}
		const delivered = (messages: SyncMessage[]): string[] =>
			messages.flatMap((m) =>
				m.type === 'operation-batch' ? (m.operations as Operation[]).map((op) => op.id) : [],
			)

		const writer = await login('beta12-device', { lastDeliverySequence: 0 })
		const x = makeOp('beta12-device', 1, 'x')
		writer.send({
			type: 'operation-batch',
			messageId: 'b1',
			operations: [x],
			isFinal: true,
			batchIndex: 0,
		} as SyncMessage)
		// The write is committed once the store holds it.
		await vi.waitFor(
			async () =>
				expect((await store.getOperationRange('beta12-device', 1, 1)).map((o) => o.id)).toEqual([
					x.id,
				]),
			WAIT,
		)

		// A version-vector client syncs and receives X.
		const first = await login('beta12-peer')
		await vi.waitFor(() => expect(delivered(first.messages)).toContain(x.id), WAIT)
		first.close()
		await vi.waitFor(async () => {
			expect((await server.getStatus()).connectedNodeIds).not.toContain('beta12-peer')
		}, WAIT)

		// Offline meanwhile: the beta.12 writer's concurrent transaction lands as a pair.
		const y = makeOp('beta12-device', 1, 'y')
		writer.send({
			type: 'operation-batch',
			messageId: 'b2',
			operations: [y],
			isFinal: true,
			batchIndex: 0,
		} as SyncMessage)
		await vi.waitFor(
			async () =>
				expect(
					(await store.getOperationRange('beta12-device', 1, 1)).map((o) => o.id).sort(),
				).toEqual([x.id, y.id].sort()),
			WAIT,
		)

		// The vector client reconnects reporting what it holds.
		const again = await login('beta12-peer', { versionVector: { 'beta12-device': 1 } })
		await vi.waitFor(() => expect(delivered(again.messages)).toContain(y.id), WAIT)
	})
})
