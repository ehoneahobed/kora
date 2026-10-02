/**
 * RT-37 and RT-39 at the session level, through a real KoraSyncServer and in-memory
 * transports.
 *
 * RT-37: a client without the `sequenceReservation` handshake capability (Kora <=
 * beta.13) may legitimately put two operations under one (node, sequence). Its pair is
 * stored and delivered to every other device; a capable client is still refused.
 *
 * RT-39: operations the server already stores (the upgrade re-upload) do not consume
 * the per-operation ingest budget; each batch costs one unit for its lookup, so
 * lookups are never free; and the budget is per device node.
 */
import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { LogEntry } from '../../src/logging/structured-logger'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { PostgresServerStore } from '../../src/store/postgres-server-store'
import type { ServerStore } from '../../src/store/server-store'
import { createSqliteServerStore } from '../../src/store/sqlite-server-store'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'
import type { KoraSyncServerConfig } from '../../src/types'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string() } } },
})

interface Client {
	messages: SyncMessage[]
	send: (message: SyncMessage) => void
}

let cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const fn of cleanups.reverse()) await fn()
	cleanups = []
})

const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let counter = 0
function makeOp(nodeId: string, sequenceNumber: number, title = 't'): Operation {
	counter += 1
	return {
		id: `legacy-op-${nodeId}-${sequenceNumber}-${counter}`,
		nodeId,
		type: 'insert',
		collection: 'notes',
		recordId: `legacy-rec-${counter}`,
		data: { title },
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: counter, nodeId },
		sequenceNumber,
		causalDeps: [],
		schemaVersion: 1,
	}
}

function batch(ops: Operation[]): SyncMessage {
	return {
		type: 'operation-batch',
		messageId: `b-${Math.random()}`,
		operations: ops,
		isFinal: true,
		batchIndex: 0,
	}
}

let pgSchemas = 0
async function openStore(kind: 'memory' | 'sqlite' | 'postgres'): Promise<ServerStore> {
	if (kind === 'memory') return new MemoryServerStore('server-1')
	if (kind === 'sqlite')
		return createSqliteServerStore({ filename: ':memory:', nodeId: 'server-1' })
	const url = process.env.KORA_PG_TEST_URL as string
	pgSchemas += 1
	const name = `kora_legacy_seq_${process.pid}_${pgSchemas}`
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

async function startServer(
	store: ServerStore,
	extra: Partial<KoraSyncServerConfig> = {},
): Promise<{ server: KoraSyncServer; logs: LogEntry[]; login: Login }> {
	await store.setSchema(schema)
	const logs: LogEntry[] = []
	const server = new KoraSyncServer({
		store,
		relayRetransmitIntervalMs: 0,
		deliveryPollIntervalMs: 0,
		logger: { log: (entry) => logs.push(entry) },
		...extra,
	})
	cleanups.push(async () => {
		await server.stop()
	})
	const login: Login = async (nodeId, handshake = {}) => {
		const { client, server: transport } = createServerTransportPair()
		const messages: SyncMessage[] = []
		client.onMessage((m) => messages.push(m))
		server.handleConnection(transport)
		const send = (message: SyncMessage): void => {
			try {
				client.send(message)
			} catch {
				// closed by the server
			}
		}
		send({
			type: 'handshake',
			messageId: `hs-${nodeId}-${Math.random()}`,
			nodeId,
			versionVector: {},
			schemaVersion: schema.version,
			...handshake,
		} as SyncMessage)
		await vi.waitFor(() => expect(messages.some((m) => m.type === 'handshake-response')).toBe(true))
		await tick()
		return { messages, send }
	}
	return { server, logs, login }
}

type Login = (nodeId: string, handshake?: Partial<SyncMessage>) => Promise<Client>

function deliveredIds(messages: SyncMessage[]): string[] {
	return messages.flatMap((m) =>
		m.type === 'operation-batch' ? (m.operations as Operation[]).map((op) => op.id) : [],
	)
}

function rejections(messages: SyncMessage[]): Array<{ code: string; retriable: boolean }> {
	return messages
		.filter((m) => m.type === 'operation-rejected')
		.map((m) => {
			const r = m as unknown as { code: string; retriable: boolean }
			return { code: r.code, retriable: r.retriable }
		})
}

async function acked(client: Client, count: number): Promise<void> {
	await vi.waitFor(() =>
		expect(
			client.messages.filter((m) => m.type === 'acknowledgment').length,
		).toBeGreaterThanOrEqual(count),
	)
	await tick()
}

const kinds = [
	'memory',
	'sqlite',
	...(process.env.KORA_PG_TEST_URL ? (['postgres'] as const) : []),
] as const

describe.each(kinds)('RT-37: legacy sequence pairs (%s store)', (kind) => {
	test('a client without sequenceReservation keeps both ops of a pair; peers receive both', async () => {
		const store = await openStore(kind)
		const { login, logs } = await startServer(store)
		// A peer streaming live before the pair arrives.
		const live = await login('peer-live', { lastDeliverySequence: 0 } as Partial<SyncMessage>)

		const legacy = await login('beta13-device', { lastDeliverySequence: 0 } as Partial<SyncMessage>)
		const x = makeOp('beta13-device', 1, 'x')
		const y = makeOp('beta13-device', 1, 'y')
		legacy.send(batch([x, y]))
		await acked(legacy, 1)

		expect(rejections(legacy.messages)).toEqual([])
		const ack = legacy.messages.find((m) => m.type === 'acknowledgment') as
			| { lastSequenceNumber: number }
			| undefined
		expect(ack?.lastSequenceNumber).toBe(1)
		const event = logs.find((entry) => entry.event === 'session.legacy_sequence_pair')
		expect(event).toMatchObject({
			nodeId: 'beta13-device',
			details: { operationId: y.id, holderIds: [x.id], legacyWriter: true },
		})

		// Live relay, a fresh watermark client (delivery stream), and a version-vector
		// client (range path) all receive both operations.
		await vi.waitFor(() =>
			expect(deliveredIds(live.messages)).toEqual(expect.arrayContaining([x.id, y.id])),
		)
		const stream = await login('peer-stream', { lastDeliverySequence: 0 } as Partial<SyncMessage>)
		await vi.waitFor(() =>
			expect(deliveredIds(stream.messages)).toEqual(expect.arrayContaining([x.id, y.id])),
		)
		const vector = await login('peer-vector')
		await vi.waitFor(() =>
			expect(deliveredIds(vector.messages)).toEqual(expect.arrayContaining([x.id, y.id])),
		)

		// The device, once upgraded (capable), re-uploads both: duplicates, no conflict.
		const upgraded = await login('beta13-device', {
			lastDeliverySequence: 0,
			sequenceReservation: true,
		} as Partial<SyncMessage>)
		upgraded.send(batch([x, y]))
		await acked(upgraded, 1)
		expect(rejections(upgraded.messages)).toEqual([])
	})

	test('a client advertising sequenceReservation is refused a held sequence (non-retriable)', async () => {
		const store = await openStore(kind)
		const { login, logs } = await startServer(store)
		const c = await login('w6-device', {
			lastDeliverySequence: 0,
			sequenceReservation: true,
		} as Partial<SyncMessage>)
		const x = makeOp('w6-device', 1, 'x')
		const y = makeOp('w6-device', 1, 'y')
		c.send(batch([x, y]))
		await acked(c, 1)
		expect(rejections(c.messages)).toEqual([{ code: 'SEQUENCE_CONFLICT', retriable: false }])
		const ids = (await store.getOperationsAfterDelivery(0, 100)).map((d) => d.operation.id)
		expect(ids).toContain(x.id)
		expect(ids).not.toContain(y.id)
		expect(logs.some((entry) => entry.event === 'session.legacy_sequence_pair')).toBe(false)
	})
})

describe('RT-39: stored duplicates and the ingest budget', () => {
	test('re-uploading stored operations does not consume the per-operation budget', async () => {
		const store = new MemoryServerStore('server-1')
		const history = Array.from({ length: 50 }, (_, i) => makeOp('pos', i + 1))
		await store.setSchema(schema)
		for (const op of history) await store.applyRemoteOperation(op)

		// Budget of 10 units: 5 batches of 10 stored ops (5 units) and one new op (1 unit).
		const { login } = await startServer(store, { maxOpsPerMinute: 10 })
		const c = await login('pos', { lastDeliverySequence: 0 } as Partial<SyncMessage>)
		for (let i = 0; i < 5; i++) c.send(batch(history.slice(i * 10, i * 10 + 10)))
		const fresh = makeOp('pos', 51)
		c.send(batch([fresh]))
		await acked(c, 6)
		expect(c.messages.filter((m) => m.type === 'error')).toEqual([])
		expect((await store.findStoredOperations([fresh.id])).has(fresh.id)).toBe(true)
	})

	test('each batch still costs one unit, so lookups cannot be spammed for free', async () => {
		const store = new MemoryServerStore('server-1')
		await store.setSchema(schema)
		const stored = makeOp('spam', 1)
		await store.applyRemoteOperation(stored)
		const { login } = await startServer(store, { maxOpsPerMinute: 3 })
		const c = await login('spam', { lastDeliverySequence: 0 } as Partial<SyncMessage>)
		for (let i = 0; i < 4; i++) c.send(batch([stored]))
		await acked(c, 4)
		const errors = c.messages.filter((m) => m.type === 'error') as Array<{
			code: string
			retriable: boolean
		}>
		expect(errors.map((e) => [e.code, e.retriable])).toEqual([['RATE_LIMIT', true]])
	})

	test('a batch of N new operations costs N units (the lookup unit is credited)', async () => {
		const store = new MemoryServerStore('server-1')
		const { login } = await startServer(store, { maxOpsPerMinute: 3 })
		const c = await login('fresh', { lastDeliverySequence: 0 } as Partial<SyncMessage>)
		c.send(batch([makeOp('fresh', 1), makeOp('fresh', 2), makeOp('fresh', 3)]))
		await acked(c, 1)
		expect(c.messages.filter((m) => m.type === 'error')).toEqual([])
		c.send(batch([makeOp('fresh', 4)]))
		await acked(c, 2)
		expect(
			c.messages.filter((m) => m.type === 'error').map((m) => (m as { code: string }).code),
		).toEqual(['RATE_LIMIT'])
	})

	test("one node's exhausted budget does not throttle another node of the same user", async () => {
		const store = new MemoryServerStore('server-1')
		const auth = {
			authenticate: async () => ({ userId: 'same-user' }),
		}
		const { login } = await startServer(store, { maxOpsPerMinute: 2, auth })
		const a = await login('device-a', {
			lastDeliverySequence: 0,
			authToken: 't',
		} as Partial<SyncMessage>)
		const b = await login('device-b', {
			lastDeliverySequence: 0,
			authToken: 't',
		} as Partial<SyncMessage>)
		a.send(batch([makeOp('device-a', 1), makeOp('device-a', 2), makeOp('device-a', 3)]))
		await acked(a, 1)
		expect(a.messages.some((m) => m.type === 'error')).toBe(true)
		b.send(batch([makeOp('device-b', 1), makeOp('device-b', 2)]))
		await acked(b, 1)
		expect(b.messages.filter((m) => m.type === 'error')).toEqual([])
		expect(rejections(b.messages)).toEqual([])
	})
})
