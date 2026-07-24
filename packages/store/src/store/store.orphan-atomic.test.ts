import { HybridLogicalClock, createOperation, defineSchema, t } from '@korajs/core'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from './store'

const schema = defineSchema({
	version: 1,
	collections: { items: { fields: { n: t.number().default(0), title: t.string() } } },
})
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

async function inc(seq: number, wall: number, delta: number, base: number) {
	const clock = new HybridLogicalClock('remote', { now: () => wall })
	return createOperation(
		{
			nodeId: 'remote',
			type: 'update',
			collection: 'items',
			recordId: 'r1',
			data: { n: base + delta },
			previousData: { n: base },
			sequenceNumber: seq,
			causalDeps: [],
			schemaVersion: 1,
			atomicOps: { n: { type: 'increment', value: delta } },
		},
		clock,
	)
}
async function insert(seq: number, wall: number) {
	const clock = new HybridLogicalClock('remote', { now: () => wall })
	return createOperation(
		{
			nodeId: 'remote',
			type: 'insert',
			collection: 'items',
			recordId: 'r1',
			data: { n: 0, title: 'x' },
			previousData: null,
			sequenceNumber: seq,
			causalDeps: [],
			schemaVersion: 1,
		},
		clock,
	)
}

test('ORPHAN: two atomic increments arriving before the insert compose (not LWW)', async () => {
	// Reordered delivery: both increments arrive BEFORE the insert.
	await store.applyRemoteOperation(await inc(2, 2000, 5, 0)) // +5
	await store.applyRemoteOperation(await inc(3, 3000, 3, 0)) // +3
	await store.applyRemoteOperation(await insert(1, 1000)) // insert lands last -> fold orphans
	const rec = (await store.collection('items').findById('r1')) as Record<string, unknown> | null
	expect(rec?.n).toBe(8)
})
