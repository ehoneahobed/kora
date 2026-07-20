import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from './store'

/**
 * A remote insert can target a record id that already has a materialized row:
 * the pipeline's insert-vs-insert merge path re-applies an insert for an
 * existing record, and a relayed insert can race the local one. A plain SQL
 * INSERT would either throw a UNIQUE constraint violation (crashing the apply
 * and stranding the operation) or, on a timestamp tie, silently skip
 * materializing the merged result. Neither is acceptable: the newer insert
 * must materialize as an upsert.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
			},
		},
	},
})

function makeInsert(overrides: Partial<Operation>): Operation {
	return {
		id: `op-${Math.random().toString(36).slice(2)}`,
		nodeId: 'remote-node',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'first', completed: false },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'remote-node' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe('remote insert onto an existing materialized row', () => {
	let store: Store
	let adapter: BetterSqlite3Adapter

	beforeEach(async () => {
		adapter = new BetterSqlite3Adapter(':memory:')
		store = new Store({ schema, adapter, nodeId: 'local-node' })
		await store.open()
	})

	afterEach(async () => {
		await store.close()
	})

	test('a NEWER insert for an existing record id upserts instead of crashing', async () => {
		const first = makeInsert({
			id: 'op-insert-old',
			data: { title: 'first', completed: false },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			sequenceNumber: 1,
		})
		await store.applyRemoteOperation(first)

		const second = makeInsert({
			id: 'op-insert-new',
			nodeId: 'node-b',
			data: { title: 'second', completed: true },
			timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-b' },
			sequenceNumber: 1,
		})

		// Must not throw, must return applied, and must materialize the newer data.
		const result = await store.applyRemoteOperation(second)
		expect(result).toBe('applied')

		const record = await store.collection('todos').findById('rec-1')
		expect(record?.title).toBe('second')
		expect(record?.completed).toBe(true)
	})

	test('an OLDER insert for an existing record id is a stale no-op (still logged)', async () => {
		const first = makeInsert({
			id: 'op-insert-newer',
			data: { title: 'current', completed: true },
			timestamp: { wallTime: 5000, logical: 0, nodeId: 'node-a' },
			sequenceNumber: 1,
		})
		await store.applyRemoteOperation(first)

		const stale = makeInsert({
			id: 'op-insert-stale',
			nodeId: 'node-b',
			data: { title: 'stale', completed: false },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			sequenceNumber: 1,
		})
		const result = await store.applyRemoteOperation(stale)
		expect(result).toBe('applied')

		const record = await store.collection('todos').findById('rec-1')
		expect(record?.title).toBe('current')

		// The stale op is still in the append-only log (dedup, causal deps).
		const ops = await store.getAllOperations()
		expect(ops.map((o) => o.id)).toContain('op-insert-stale')
	})
})
