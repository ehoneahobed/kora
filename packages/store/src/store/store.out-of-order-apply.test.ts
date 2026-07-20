import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from './store'

/**
 * The sync protocol sends operations in causal order, but transports can
 * reorder delivery (the chaos config explicitly models this). If an UPDATE for
 * a record arrives before its INSERT, the update must not be lost from the
 * materialized row once the insert lands: the developer's data would silently
 * miss a change that IS in the operation log.
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

function makeOp(overrides: Partial<Operation>): Operation {
	return {
		id: `op-${Math.random().toString(36).slice(2)}`,
		nodeId: 'remote-node',
		type: 'update',
		collection: 'todos',
		recordId: 'rec-1',
		data: {},
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'remote-node' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe('out-of-order remote apply (update delivered before its insert)', () => {
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

	test('update applied before insert still materializes once the insert arrives', async () => {
		const insert = makeOp({
			id: 'op-insert',
			type: 'insert',
			data: { title: 'created', completed: false },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'remote-node' },
			sequenceNumber: 1,
		})
		const update = makeOp({
			id: 'op-update',
			type: 'update',
			data: { title: 'updated' },
			previousData: { title: 'created' },
			timestamp: { wallTime: 2000, logical: 0, nodeId: 'remote-node' },
			sequenceNumber: 2,
			causalDeps: ['op-insert'],
		})

		// Reordered delivery: update first, then insert.
		await store.applyRemoteOperation(update)
		await store.applyRemoteOperation(insert)

		// The update is NEWER than the insert; the materialized row must reflect
		// it — matching what any device that received them in order shows.
		const record = await store.collection('todos').findById('rec-1')
		expect(record).not.toBeNull()
		expect(record?.title).toBe('updated')
		expect(record?.completed).toBe(false)

		// Both ops are in the log regardless.
		const ops = await store.getAllOperations()
		expect(ops.map((o) => o.id).sort()).toEqual(['op-insert', 'op-update'])
	})

	test('delete applied before insert leaves the row tombstoned once the insert arrives', async () => {
		const del = makeOp({
			id: 'op-delete',
			type: 'delete',
			data: null,
			timestamp: { wallTime: 3000, logical: 0, nodeId: 'remote-node' },
			sequenceNumber: 2,
			causalDeps: ['op-insert'],
		})
		const insert = makeOp({
			id: 'op-insert',
			type: 'insert',
			data: { title: 'short-lived', completed: false },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'remote-node' },
			sequenceNumber: 1,
		})

		await store.applyRemoteOperation(del)
		await store.applyRemoteOperation(insert)

		// In-order devices show a deleted record; the reordered device must too.
		const record = await store.collection('todos').findById('rec-1')
		expect(record).toBeNull()
	})

	test('multiple orphaned updates from different nodes fold to the max-timestamp winner per field', async () => {
		const updateOld = makeOp({
			id: 'op-upd-old',
			nodeId: 'node-x',
			data: { title: 'older' },
			previousData: { title: 'created' },
			timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-x' },
			sequenceNumber: 1,
		})
		const updateNew = makeOp({
			id: 'op-upd-new',
			nodeId: 'node-y',
			data: { title: 'newest', completed: true },
			previousData: { title: 'created', completed: false },
			timestamp: { wallTime: 4000, logical: 0, nodeId: 'node-y' },
			sequenceNumber: 1,
		})
		const insert = makeOp({
			id: 'op-insert',
			type: 'insert',
			data: { title: 'created', completed: false },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'remote-node' },
			sequenceNumber: 1,
		})

		// Worst case: BOTH updates beat the insert, newest-first delivery.
		await store.applyRemoteOperation(updateNew)
		await store.applyRemoteOperation(updateOld)
		await store.applyRemoteOperation(insert)

		const record = await store.collection('todos').findById('rec-1')
		expect(record?.title).toBe('newest')
		expect(record?.completed).toBe(true)
	})
})
