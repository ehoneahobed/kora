import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { Store } from '../../src/store/store'

/**
 * Regression coverage for the `forceMaterialize` apply option.
 *
 * A three-way merge result is authoritative: it already folds in the current
 * local row, so it must materialize even when its HLC timestamp ties the
 * current row version. That tie is exactly what happens on the device that
 * authored the newer of two concurrent edits — the merged op reuses that
 * device's own (newest) timestamp. Under the plain LWW guard (strictly-newer)
 * the write was silently dropped, so that device never converged. This test
 * pins the store contract that `forceMaterialize` bypasses the LWW guard while
 * the default still enforces it.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				value: t.string().optional(),
			},
		},
	},
})

describe('Integration: forceMaterialize bypasses the LWW version tie', () => {
	let adapter: BetterSqlite3Adapter
	let store: Store

	beforeEach(async () => {
		adapter = new BetterSqlite3Adapter(':memory:')
		store = new Store({ schema, adapter, nodeId: 'node-a' })
		await store.open()
	})

	afterEach(async () => {
		await store.close()
	})

	function tiedUpdateOp(
		recordId: string,
		id: string,
		timestamp: Operation['timestamp'],
	): Operation {
		return {
			id,
			nodeId: 'node-b',
			type: 'update',
			collection: 'items',
			recordId,
			data: { value: 'merged' },
			previousData: { value: 'v1' },
			timestamp,
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		}
	}

	test('default apply keeps LWW: an update tying the row version does not materialize', async () => {
		const record = await store.collection('items').insert({ value: 'v1' })
		const insertOp = (await store.getAllOperations())[0]
		if (!insertOp) throw new Error('missing insert op')

		// An update whose timestamp exactly ties the current row version.
		await store.applyRemoteOperation(tiedUpdateOp(record.id, 'op-skip', insertOp.timestamp))

		const found = await store.collection('items').findById(record.id)
		expect(found?.value).toBe('v1')
	})

	test('forceMaterialize applies the update despite the tie', async () => {
		const record = await store.collection('items').insert({ value: 'v1' })
		const insertOp = (await store.getAllOperations())[0]
		if (!insertOp) throw new Error('missing insert op')

		await store.applyRemoteOperation(tiedUpdateOp(record.id, 'op-force', insertOp.timestamp), {
			forceMaterialize: true,
		})

		const found = await store.collection('items').findById(record.id)
		expect(found?.value).toBe('merged')
	})
})
