import { HybridLogicalClock, createOperation, defineSchema, t } from '@korajs/core'
import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from './store'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
			},
		},
	},
})

describe('Store applyRemoteOperation LWW', () => {
	let store: Store
	let adapter: BetterSqlite3Adapter

	beforeEach(async () => {
		adapter = new BetterSqlite3Adapter(':memory:')
		store = new Store({ schema, adapter })
		await store.open()
	})

	afterEach(async () => {
		await store.close()
	})

	test('does not overwrite newer local materialized state with older remote update', async () => {
		const col = store.collection('todos')
		const record = await col.insert({ title: 'From A' })

		const staleClock = new HybridLogicalClock('remote-node', { now: () => 1000 })
		const staleOp = await createOperation(
			{
				nodeId: 'remote-node',
				type: 'update',
				collection: 'todos',
				recordId: record.id,
				data: { title: 'From B stale' },
				previousData: { title: 'Base' },
				sequenceNumber: 1,
				causalDeps: [],
				schemaVersion: 1,
			},
			staleClock,
		)

		await store.applyRemoteOperation(staleOp)

		const found = await col.findById(record.id)
		expect(found?.title).toBe('From A')
	})
})
