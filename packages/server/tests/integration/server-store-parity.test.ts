import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, expect, test } from 'vitest'
import { applyServerOperation } from '../../src/apply/apply-server-operation'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createPostgresServerStore } from '../../src/store/postgres-server-store'
import type { ServerStore } from '../../src/store/server-store'
import { SqliteServerStore } from '../../src/store/sqlite-server-store'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
			},
			constraints: [
				{
					type: 'unique',
					fields: ['title'],
					onConflict: 'last-write-wins',
				},
			],
		},
	},
})

function createTestOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: `op-${Math.random().toString(36).slice(2)}`,
		nodeId: 'node-a',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'alpha' },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

async function runSharedStoreParityTests(
	label: string,
	createStore: () => Promise<ServerStore>,
): Promise<void> {
	test(`${label}: applies insert and materializes record`, async () => {
		const store = await createStore()
		await store.setSchema(schema)

		const op = createTestOp()
		const result = await applyServerOperation(store, op)
		expect(result.result).toBe('applied')

		const row = await store.findRecord('todos', 'rec-1')
		expect(row?.title).toBe('alpha')

		await store.close()
	})

	test(`${label}: rejects duplicate unique constraint on ingest`, async () => {
		const store = await createStore()
		await store.setSchema(schema)

		await applyServerOperation(
			store,
			createTestOp({ id: 'op-a', recordId: 'rec-a', data: { title: 'dup' } }),
		)
		const second = await applyServerOperation(
			store,
			createTestOp({ id: 'op-b', recordId: 'rec-b', data: { title: 'dup' }, sequenceNumber: 2 }),
		)
		expect(second.rejection?.code).toBe('CONSTRAINT_VIOLATION')

		await store.close()
	})

	test(`${label}: deduplicates identical operation ids`, async () => {
		const store = await createStore()
		await store.setSchema(schema)

		const op = createTestOp({ id: 'same-id' })
		expect((await applyServerOperation(store, op)).result).toBe('applied')
		expect((await applyServerOperation(store, op)).result).toBe('duplicate')
		expect(await store.getOperationCount()).toBe(1)

		await store.close()
	})
}

describe('server store parity', () => {
	runSharedStoreParityTests('memory', async () => new MemoryServerStore('parity-node'))
	runSharedStoreParityTests('sqlite', async () => {
		const sqlite = new Database(':memory:')
		return new SqliteServerStore(drizzle(sqlite), 'parity-sqlite')
	})

	const postgresUrl = process.env.DATABASE_URL
	describe.skipIf(!postgresUrl)('postgres (live)', () => {
		runSharedStoreParityTests('postgres', async () =>
			createPostgresServerStore({
				connectionString: postgresUrl as string,
				nodeId: 'parity-postgres',
			}),
		)
	})
})
