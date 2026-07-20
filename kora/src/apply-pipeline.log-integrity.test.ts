import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { MergeEngine } from '@korajs/merge'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { MergeAwareSyncStore } from './merge-aware-sync-store'

/**
 * Operations are immutable and content-addressed: what the sync layer applies
 * must be logged EXACTLY as received, even when the merge engine computes a
 * different value for the materialized row. Before this contract existed, the
 * merge paths logged the merged data under the original op's id — a node
 * re-serving that op would propagate values the originating device never
 * wrote, silently corrupting the DAG.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				// Array forces the three-tier merge engine (add-wins-set).
				tags: t.array(t.string()).default([]),
			},
		},
	},
})

describe('merge apply preserves the canonical operation in the log', () => {
	let store: Store
	let adapter: BetterSqlite3Adapter
	let syncStore: MergeAwareSyncStore

	beforeEach(async () => {
		adapter = new BetterSqlite3Adapter(':memory:')
		store = new Store({ schema, adapter, nodeId: 'local-node' })
		await store.open()
		syncStore = new MergeAwareSyncStore(store, new MergeEngine(), null)
	})

	afterEach(async () => {
		await store.close()
	})

	test('conflicting array update: row gets the union, log keeps the original op data', async () => {
		const insert: Operation = {
			id: 'op-insert',
			nodeId: 'remote-node',
			type: 'insert',
			collection: 'todos',
			recordId: 'rec-1',
			data: { title: 'seed', tags: ['base'] },
			previousData: null,
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'remote-node' },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		}
		await store.applyRemoteOperation(insert)

		// Local concurrent edit: adds "local-tag".
		await store.collection('todos').update('rec-1', { tags: ['base', 'local-tag'] })

		// Remote concurrent edit from the same base: adds "remote-tag".
		const remoteUpdate: Operation = {
			id: 'op-remote-update',
			nodeId: 'remote-node',
			type: 'update',
			collection: 'todos',
			recordId: 'rec-1',
			data: { tags: ['base', 'remote-tag'] },
			previousData: { tags: ['base'] },
			timestamp: { wallTime: 2000, logical: 0, nodeId: 'remote-node' },
			sequenceNumber: 2,
			causalDeps: ['op-insert'],
			schemaVersion: 1,
		}
		const result = await syncStore.applyRemoteOperation(remoteUpdate)
		expect(result).toBe('applied')

		// Row: add-wins union of both edits.
		const record = await store.collection('todos').findById('rec-1')
		expect([...(record?.tags as string[])].sort()).toEqual(['base', 'local-tag', 'remote-tag'])

		// Log: the canonical remote op, byte-for-byte the data it arrived with.
		const ops = await store.getAllOperations()
		const logged = ops.find((o) => o.id === 'op-remote-update')
		expect(logged).toBeDefined()
		expect(logged?.data).toEqual({ tags: ['base', 'remote-tag'] })
		expect(logged?.timestamp).toEqual({ wallTime: 2000, logical: 0, nodeId: 'remote-node' })
	})
})
