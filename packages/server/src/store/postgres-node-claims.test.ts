import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { PostgresServerStore } from './postgres-server-store'

/**
 * Real-Postgres node-claim contract (RT-5): history without a claim is not
 * adoptable, an admin release hands the node to exactly one next claimant, and
 * concurrent claims of a fresh node have one winner. Set KORA_PG_TEST_URL to run.
 */
const PG_URL = process.env.KORA_PG_TEST_URL

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string() } } },
})

describe.skipIf(!PG_URL)('Postgres node claims (RT-5)', () => {
	let client: ReturnType<typeof postgres>
	let store: PostgresServerStore
	const PG_SCHEMA = 'kora_test_node_claims'

	beforeAll(async () => {
		client = postgres(PG_URL as string, { max: 4, connection: { search_path: PG_SCHEMA } })
		await client.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}`)
	})

	afterAll(async () => {
		await store.close()
		await client.end()
	})

	beforeEach(async () => {
		await client.unsafe('DROP TABLE IF EXISTS notes, operations, sync_state, node_claims CASCADE')
		store = new PostgresServerStore(drizzle(client), 'server-pg')
		await store.setSchema(schema)
	})

	function op(nodeId: string): Operation {
		return {
			id: `op-${Math.random().toString(36).slice(2)}`,
			nodeId,
			type: 'insert',
			collection: 'notes',
			recordId: `rec-${Math.random().toString(36).slice(2)}`,
			data: { title: 'x' },
			previousData: null,
			timestamp: { wallTime: Date.now(), logical: 0, nodeId },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		}
	}

	test('a fresh node is claimed once; others are refused', async () => {
		expect(await store.claimNode('dev-1', 'alice')).toBe(true)
		expect(await store.claimNode('dev-1', 'alice')).toBe(true)
		expect(await store.claimNode('dev-1', 'mallory')).toBe(false)
	})

	test('an unclaimed node with history is refused until released', async () => {
		await store.applyRemoteOperation(op('legacy'))
		expect(await store.claimNode('legacy', 'mallory')).toBe(false)
		expect(await store.releaseNodeClaim('legacy')).toBe(true)
		expect(await store.claimNode('legacy', 'alice')).toBe(true)
		expect(await store.claimNode('legacy', 'mallory')).toBe(false)
		expect(await store.releaseNodeClaim('unknown')).toBe(false)
		expect(await store.claimNode('fresh', '')).toBe(false)
	})

	test('concurrent claims of a released node have exactly one winner', async () => {
		await store.applyRemoteOperation(op('contested'))
		await store.releaseNodeClaim('contested')
		const results = await Promise.all(
			['a', 'b', 'c', 'd'].map((user) => store.claimNode('contested', user)),
		)
		expect(results.filter(Boolean)).toHaveLength(1)
	})
})
