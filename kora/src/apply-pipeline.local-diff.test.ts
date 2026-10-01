import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { MergeEngine } from '@korajs/merge'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { MergeAwareSyncStore } from './merge-aware-sync-store'

/**
 * S1 interim (MERGE-1, NEW-MERGE-1): when a remote update conflicts, the local
 * side of the pairwise merge contains only fields whose local value differs from
 * the base the remote op wrote from. A field the local device never changed must
 * not compete with the remote change, and a one-sided array removal must stick.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				tags: t.array(t.string()).default([]),
			},
		},
	},
})

function remoteOp(partial: Partial<Operation> & Pick<Operation, 'id' | 'type'>): Operation {
	return {
		nodeId: 'remote-node',
		collection: 'todos',
		recordId: 'rec-1',
		data: null,
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'remote-node' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...partial,
	}
}

describe('ApplyPipeline merge: local side is a real diff against the base', () => {
	let store: Store
	let syncStore: MergeAwareSyncStore

	beforeEach(async () => {
		store = new Store({ schema, adapter: new BetterSqlite3Adapter(':memory:'), nodeId: 'local' })
		await store.open()
		syncStore = new MergeAwareSyncStore(store, new MergeEngine(), null)
		await store.applyRemoteOperation(
			remoteOp({ id: 'op-insert', type: 'insert', data: { title: 't', tags: ['urgent'] } }),
		)
	})

	afterEach(async () => {
		await store.close()
	})

	test('an unchanged local field does not override the remote change, and a local removal sticks', async () => {
		// Local (newer HLC than the remote op below) removes "urgent"; title untouched.
		await store.collection('todos').update('rec-1', { tags: [] })

		// Remote saved the form: a new title, with the tags it saw restated unchanged.
		await syncStore.applyRemoteOperation(
			remoteOp({
				id: 'op-remote-save',
				type: 'update',
				data: { title: 'renamed', tags: ['urgent'] },
				previousData: { title: 't', tags: ['urgent'] },
				timestamp: { wallTime: 1500, logical: 0, nodeId: 'remote-node' },
				sequenceNumber: 2,
				causalDeps: ['op-insert'],
			}),
		)

		const record = await store.collection('todos').findById('rec-1')
		expect(record?.title).toBe('renamed')
		expect(record?.tags).toEqual([])
	})

	test('a concurrent local addition and remote removal both apply', async () => {
		await store.collection('todos').update('rec-1', { tags: ['urgent', 'billing'] })

		await syncStore.applyRemoteOperation(
			remoteOp({
				id: 'op-remote-remove',
				type: 'update',
				data: { tags: [] },
				previousData: { tags: ['urgent'] },
				timestamp: { wallTime: 1500, logical: 0, nodeId: 'remote-node' },
				sequenceNumber: 2,
				causalDeps: ['op-insert'],
			}),
		)

		const record = await store.collection('todos').findById('rec-1')
		expect(record?.tags).toEqual(['billing'])
	})
})
