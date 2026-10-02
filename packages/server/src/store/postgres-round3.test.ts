import { type Operation, defineSchema, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { PostgresServerStore } from './postgres-server-store'

/**
 * Real-Postgres contract for the store methods added in red-team round 3: the
 * record's newest HLC and per-field versions (RT-19, RT-27), the snapshot-field
 * fingerprint in kora_server_meta (RT-20), and the compare-and-set node-claim
 * re-issue behind provisional anonymous claims (RT-21). Set KORA_PG_TEST_URL to run.
 */
const PG_URL = process.env.KORA_PG_TEST_URL
const PG_SCHEMA = 'kora_test_round3'

let seq = 0
function op(overrides: Partial<Operation>): Operation {
	seq += 1
	return {
		id: `pg-r3-${seq}`,
		nodeId: 'n',
		type: 'insert',
		collection: 'todos',
		recordId: 'todo-1',
		data: {},
		previousData: null,
		timestamp: { wallTime: 1000 + seq, logical: 0, nodeId: 'n' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe.skipIf(!PG_URL)('Postgres round-3 store contract', () => {
	let client: ReturnType<typeof postgres>

	beforeAll(async () => {
		client = postgres(PG_URL as string, { max: 6, connection: { search_path: PG_SCHEMA } })
		await client.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}`)
	})

	afterAll(async () => {
		await client.end()
	})

	beforeEach(async () => {
		await client.unsafe(
			'DROP TABLE IF EXISTS todos, operations, sync_state, node_claims, blob_owners, delivery_counter, kora_server_meta CASCADE',
		)
	})

	test('node-id ties break in byte order, like HLC.compare, whatever the collation', async () => {
		const store = new PostgresServerStore(drizzle(client), 'server-pg')
		await store.setSchema(
			defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } }),
		)
		// Production databases often use a linguistic collation (en_US), under which
		// 'node-a' < 'node-Z'. Force one on the column when the server has ICU.
		const icu = (await client.unsafe(
			`SELECT 1 FROM pg_collation WHERE collname = 'en-x-icu'`,
		)) as unknown[]
		if (icu.length > 0) {
			await client.unsafe(
				`ALTER TABLE operations ALTER COLUMN timestamp_node_id TYPE TEXT COLLATE "en-x-icu"`,
			)
		}
		await store.applyRemoteOperation(op({ data: { title: 'a' } }))
		// 'Z' (0x5A) sorts before 'a' (0x61) in byte order but after it in many collations.
		for (const nodeId of ['node-Z', 'node-a']) {
			await store.applyRemoteOperation(
				op({
					type: 'update',
					nodeId,
					data: { title: nodeId },
					timestamp: { wallTime: 9000, logical: 1, nodeId },
				}),
			)
		}
		expect(await store.getRecordLatestTimestamp('todos', 'todo-1')).toEqual({
			wallTime: 9000,
			logical: 1,
			nodeId: 'node-a',
		})
		expect((await store.getRecordFieldVersions('todos', 'todo-1'))?.fields.title).toEqual({
			wallTime: 9000,
			logical: 1,
			nodeId: 'node-a',
		})
		// The materialized row folds in the same order (memory and SQLite agree).
		expect((await store.findRecord('todos', 'todo-1'))?.title).toBe('node-a')
		expect(await store.getRecordLatestTimestamp('todos', 'missing')).toBeNull()
		await store.close()
	})

	test('snapshots are recomputed once when the captured fields change (RT-20)', async () => {
		const v1 = defineSchema({
			version: 1,
			collections: { todos: { fields: { title: t.string() } } },
		})
		const v2 = defineSchema({
			version: 2,
			collections: { todos: { fields: { title: t.string(), orgId: t.string().optional() } } },
		})
		const store = new PostgresServerStore(drizzle(client), 'server-pg')
		await store.setSchema(v1)
		const insert = op({ data: { title: 'x', orgId: 'acme' } })
		await store.applyRemoteOperation(insert)
		expect(
			(await store.getOperationScopeSnapshots([insert.id])).get(insert.id)?.post?.orgId,
		).toBeUndefined()
		await store.setSchema(v2)
		expect((await store.getOperationScopeSnapshots([insert.id])).get(insert.id)?.post?.orgId).toBe(
			'acme',
		)
		await store.close()

		// A restart with the same schema keeps the stored snapshots (no recompute).
		await client.unsafe(
			`UPDATE operations SET scope_snapshot = '{"pre":null,"post":{"id":"todo-1","orgId":"kept"}}'`,
		)
		const reopened = new PostgresServerStore(drizzle(client), 'server-pg')
		await reopened.setSchema(v2)
		expect(
			(await reopened.getOperationScopeSnapshots([insert.id])).get(insert.id)?.post?.orgId,
		).toBe('kept')
		await reopened.close()
	})

	test('concurrent claim re-issues across instances have exactly one winner (RT-21)', async () => {
		const a = new PostgresServerStore(drizzle(client), 'server-a')
		const b = new PostgresServerStore(drizzle(client), 'server-b')
		const schema = defineSchema({
			version: 1,
			collections: { todos: { fields: { title: t.string() } } },
		})
		await a.setSchema(schema)
		await b.setSchema(schema)
		expect(await a.claimNode('node-x', 'kora:anon-pending:h1:1')).toBe(true)
		expect(await b.getNodeClaimOwner('node-x')).toBe('kora:anon-pending:h1:1')
		const results = await Promise.all([
			a.replaceNodeClaim('node-x', 'kora:anon-pending:h1:1', 'kora:anon-node:h1'),
			b.replaceNodeClaim('node-x', 'kora:anon-pending:h1:1', 'kora:anon-node:h2'),
		])
		expect(results.filter(Boolean)).toHaveLength(1)
		const owner = await a.getNodeClaimOwner('node-x')
		expect(owner).toBe(results[0] ? 'kora:anon-node:h1' : 'kora:anon-node:h2')
		// A stale expected owner never overwrites.
		expect(await b.replaceNodeClaim('node-x', 'kora:anon-pending:h1:1', 'thief')).toBe(false)
		expect(await a.getNodeClaimOwner('missing')).toBeNull()
		await a.close()
		await b.close()
	})
})
