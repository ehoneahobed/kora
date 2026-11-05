import type { HLCTimestamp, Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { purgeSeedsInTx } from '../seed/seed-store'
import type { SeedInput } from '../seed/seed-store'
import { Store } from '../store/store'
import type { Transaction } from '../types'
import { type StagingMergeHost, mergeStagingInto } from './staging-merge'

/*
 * First-visit parity S4b, 5.7.4 and invariant I2: the merge deletes every seed, and the
 * replica it leaves equals the one replication alone produces (I4).
 */

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), done: t.boolean().default(false) } } },
})

let counter = 0
function op(
	type: Operation['type'],
	recordId: string,
	data: Record<string, unknown> | null,
	wall: number,
	node = 'server',
): Operation {
	counter += 1
	return {
		id: `s-${counter}`,
		nodeId: node,
		type,
		collection: 'todos',
		recordId,
		data,
		previousData: type === 'update' ? {} : null,
		timestamp: { wallTime: wall, logical: 0, nodeId: node },
		sequenceNumber: counter,
		causalDeps: [],
		schemaVersion: 1,
	}
}

const open: Store[] = []
afterEach(async () => {
	for (const store of open.splice(0)) await store.close()
})

async function newStore(nodeId: string): Promise<{ store: Store; adapter: BetterSqlite3Adapter }> {
	const adapter = new BetterSqlite3Adapter(':memory:')
	const store = new Store({ schema, adapter, nodeId, materialization: 'fold' })
	await store.open()
	open.push(store)
	return { store, adapter }
}

const stamp = (wallTime: number): HLCTimestamp => ({ wallTime, logical: 0, nodeId: 'server' })
function seedOf(id: string, title: string, wall: number): SeedInput {
	return {
		collection: 'todos',
		id,
		values: { title, done: false },
		fieldVersions: { title: stamp(wall), done: stamp(wall) },
		created: stamp(wall),
		latest: stamp(wall),
	}
}

async function mergeInto(
	live: { store: Store; adapter: BetterSqlite3Adapter },
	staging: { adapter: BetterSqlite3Adapter },
): Promise<Awaited<ReturnType<typeof mergeStagingInto>>> {
	const host: StagingMergeHost = {
		schema,
		transaction: (fn: (tx: Transaction) => Promise<void>) => live.adapter.transaction(fn),
		localNodeIds: async () => new Set(['live']),
		touchCollection: () => undefined,
		noteVersionVector: () => undefined,
		receiveTimestamp: () => undefined,
		invalidate: () => undefined,
		replay: async (operation) => {
			await live.store.applyRemoteOperation(operation)
		},
		assertWritable: () => undefined,
		shouldContinue: () => true,
		purgeSeeds: async (tx, collection, ids) => {
			await purgeSeedsInTx(
				tx,
				collection !== null && ids !== null
					? ids.map((recordId) => ({ collection, recordId }))
					: undefined,
			)
		},
		settleSnapshots: (collection, ids) => live.store.settleSnapshots(collection, ids),
	}
	return mergeStagingInto(host, staging.adapter, { writeProgress: async () => undefined })
}

const rowsOf = async (store: Store): Promise<unknown[]> =>
	(await store.collection('todos').where({}).orderBy('id').exec()).map((r) => ({
		id: r.id,
		title: r.title,
		done: r.done,
	}))

describe('the merge deletes seeds (I2) and equals replication alone (I4)', () => {
	test('seeded and unwritten records come out as the staged copy', async () => {
		const staging = await newStore('staging')
		await staging.store.applyRemoteOperation(op('insert', 'a', { title: 'A', done: false }, 100))
		await staging.store.applyRemoteOperation(op('insert', 'b', { title: 'B', done: false }, 100))
		await staging.store.applyRemoteOperation(op('update', 'b', { title: 'B2' }, 200))

		const seeded = await newStore('live')
		await seeded.store.seedRecords([seedOf('a', 'A', 100), seedOf('b', 'B', 100)], {
			frontier: 3,
			grantKey: 'g',
		})
		await seeded.store.seedRecords([seedOf('gone', 'Deleted since', 50)], {
			frontier: 3,
			grantKey: 'g',
		})
		expect((await seeded.store.listSeeds()).length).toBe(3)

		const control = await newStore('live')

		expect((await mergeInto(seeded, staging)).kind).toBe('merged')
		expect((await mergeInto(control, staging)).kind).toBe('merged')

		expect(await seeded.store.listSeeds()).toEqual([])
		expect(await rowsOf(seeded.store)).toEqual(await rowsOf(control.store))
		expect(await rowsOf(seeded.store)).toEqual([
			{ id: 'a', title: 'A', done: false },
			{ id: 'b', title: 'B2', done: false },
		])
		for (const table of ['_kora_fold_state', '_kora_fold_snapshot', '_kora_fold_base']) {
			const query = `SELECT collection, record_id, state FROM ${table} ORDER BY record_id`
			expect(await seeded.adapter.query(query)).toEqual(await control.adapter.query(query))
		}
	})

	test('a record the user wrote to ends as fold(remote and local), without the snapshot', async () => {
		const staging = await newStore('staging')
		await staging.store.applyRemoteOperation(op('insert', 'a', { title: 'A', done: false }, 100))
		await staging.store.applyRemoteOperation(op('update', 'a', { title: 'A2' }, 150))

		const seeded = await newStore('live')
		await seeded.store.seedRecords([seedOf('a', 'A', 100)], { frontier: 2, grantKey: 'g' })
		await seeded.store.collection('todos').update('a', { done: true })

		await mergeInto(seeded, staging)

		expect(await seeded.store.listSeeds()).toEqual([])
		const [row] = await rowsOf(seeded.store)
		// The server's later title and the user's own edit both survive.
		expect(row).toEqual({ id: 'a', title: 'A2', done: true })
		const snapshots = await seeded.adapter.query('SELECT * FROM _kora_fold_snapshot')
		expect(snapshots).toEqual([])
	})

	test('a written seed the staged replica never held keeps the snapshot, so the edit is not hidden', async () => {
		const staging = await newStore('staging')
		await staging.store.applyRemoteOperation(
			op('insert', 'other', { title: 'O', done: false }, 100),
		)

		const seeded = await newStore('live')
		await seeded.store.seedRecords([seedOf('x', 'X', 100)], { frontier: 2, grantKey: 'g' })
		await seeded.store.collection('todos').update('x', { done: true })

		await mergeInto(seeded, staging)

		expect(await seeded.store.listSeeds()).toEqual([])
		const x = await seeded.store.collection('todos').findById('x')
		expect(x).toMatchObject({ id: 'x', done: true })
	})
})
