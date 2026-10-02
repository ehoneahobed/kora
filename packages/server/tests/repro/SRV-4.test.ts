/**
 * SRV-4 repro (real Postgres; set KORA_PG_TEST_URL): the Postgres store's version
 * vector is a per-instance in-memory cache, the dedup check runs outside the append
 * transaction, and sequence_number is INTEGER. Asserts CORRECT behavior (fails today).
 */
import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { PostgresServerStore } from '../../src/store/postgres-server-store'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'

const PG_URL = process.env.KORA_PG_TEST_URL
const PG_SCHEMA = 'kora_repro_srv4'
const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

function mkOp(n: number, overrides: Partial<Operation> = {}): Operation {
	return {
		id: `srv4-op-${n}-${Math.random().toString(36).slice(2)}`,
		nodeId: 'client-node',
		type: 'insert',
		collection: 'todos',
		recordId: `rec-${n}`,
		data: { title: `t${n}` },
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: n, nodeId: 'client-node' },
		sequenceNumber: n,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe.skipIf(!PG_URL)('SRV-4 Postgres multi-instance correctness', () => {
	const clients: Array<ReturnType<typeof postgres>> = []
	const stores: PostgresServerStore[] = []
	async function instance(nodeId: string): Promise<PostgresServerStore> {
		const client = postgres(PG_URL as string, { max: 4, connection: { search_path: PG_SCHEMA } })
		clients.push(client)
		const store = new PostgresServerStore(drizzle(client), nodeId)
		await store.setSchema(schema)
		stores.push(store)
		return store
	}

	beforeAll(async () => {
		const admin = postgres(PG_URL as string, { max: 1 })
		await admin.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`)
		await admin.unsafe(`CREATE SCHEMA ${PG_SCHEMA}`)
		await admin.end()
	})
	afterAll(async () => {
		for (const s of stores) await s.close().catch(() => {})
		for (const c of clients) await c.end()
	})

	test('instance B version vector reflects writes committed through instance A', async () => {
		const a = await instance('srv-a')
		const b = await instance('srv-b')
		const op = mkOp(1, {
			nodeId: 'vv-node',
			timestamp: { wallTime: Date.now(), logical: 0, nodeId: 'vv-node' },
		})
		expect(await a.applyRemoteOperation(op)).toBe('applied')
		expect(b.getVersionVector().get('vv-node')).toBe(1)
	})

	test('legacy (version-vector) client handshaking on instance B receives an op written via A', async () => {
		const a = await instance('srv-a2')
		const b = await instance('srv-b2')
		const op = mkOp(1, {
			nodeId: 'legacy-writer',
			timestamp: { wallTime: Date.now(), logical: 0, nodeId: 'legacy-writer' },
		})
		await a.applyRemoteOperation(op)
		const server = new KoraSyncServer({ store: b })
		const { client, server: transport } = createServerTransportPair()
		const received: SyncMessage[] = []
		client.onMessage((m) => received.push(m))
		server.handleConnection(transport)
		// No lastDeliverySequence: an older client on the version-vector delta path.
		client.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'legacy-reader',
			versionVector: {},
			schemaVersion: 1,
		})
		await vi.waitFor(() =>
			expect(received.some((m) => m.type === 'operation-batch' && m.isFinal)).toBe(true),
		)
		const ids = received.flatMap((m) =>
			m.type === 'operation-batch' ? m.operations.map((o) => o.id) : [],
		)
		await server.stop()
		expect(ids).toContain(op.id)
	})

	test('concurrent apply of the same op on two instances reports exactly one "applied"', async () => {
		const a = await instance('srv-a3')
		const b = await instance('srv-b3')
		let dupApplied = 0
		for (let i = 0; i < 20; i++) {
			const op = mkOp(100 + i, {
				nodeId: 'race-node',
				timestamp: { wallTime: Date.now(), logical: i, nodeId: 'race-node' },
			})
			const results = await Promise.all([a.applyRemoteOperation(op), b.applyRemoteOperation(op)])
			if (results.filter((r) => r === 'applied').length > 1) dupApplied++
		}
		expect(dupApplied).toBe(0)
	})

	test('sequence numbers above 2^31-1 are stored', async () => {
		const a = await instance('srv-a4')
		const big = 2 ** 31
		const op = mkOp(big, {
			nodeId: 'big-node',
			timestamp: { wallTime: Date.now(), logical: 0, nodeId: 'big-node' },
		})
		await expect(a.applyRemoteOperation(op)).resolves.toBe('applied')
		const range = await a.getOperationRange('big-node', big, big)
		expect(range.map((o) => o.id)).toEqual([op.id])
	})
})
