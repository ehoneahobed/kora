import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { OptimisticLockError } from '../errors'
import { Store } from './store'

/**
 * Contract tests for the merge-support options of `applyRemoteOperation`:
 *
 * - `materializeData` / `materializeTimestamp`: the ROW gets the merged values
 *   and stamp, while the LOG keeps the canonical operation untouched
 *   (operations are immutable and content-addressed — a merge result must
 *   never be persisted under the original op's id).
 * - `guardRowState`: optimistic-concurrency guard. If the row's version state
 *   changed after the caller snapshotted it, the apply throws and writes
 *   NOTHING (no row change, no log append), so the caller can recompute.
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
		data: { title: 'remote title' },
		previousData: { title: 'seed' },
		timestamp: { wallTime: 2000, logical: 0, nodeId: 'remote-node' },
		sequenceNumber: 2,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe('guarded / override apply', () => {
	let store: Store
	let adapter: BetterSqlite3Adapter

	beforeEach(async () => {
		adapter = new BetterSqlite3Adapter(':memory:')
		store = new Store({ schema, adapter, nodeId: 'local-node' })
		await store.open()
		await store.applyRemoteOperation(
			makeOp({
				id: 'op-seed',
				type: 'insert',
				data: { title: 'seed', completed: false },
				previousData: null,
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'remote-node' },
				sequenceNumber: 1,
			}),
		)
	})

	afterEach(async () => {
		await store.close()
	})

	test('materializeData writes the merged value to the row but the ORIGINAL data to the log', async () => {
		const op = makeOp({ id: 'op-merge-1', data: { title: 'remote title' } })

		const result = await store.applyRemoteOperation(op, {
			forceMaterialize: true,
			materializeData: { title: 'MERGED title' },
			materializeTimestamp: { wallTime: 3000, logical: 0, nodeId: 'remote-node' },
		})
		expect(result).toBe('applied')

		// Row reflects the merge…
		const record = await store.collection('todos').findById('rec-1')
		expect(record?.title).toBe('MERGED title')

		// …but the append-only log keeps the canonical operation.
		const ops = await store.getAllOperations()
		const logged = ops.find((o) => o.id === 'op-merge-1')
		expect(logged?.data).toEqual({ title: 'remote title' })
		expect(logged?.timestamp).toEqual({ wallTime: 2000, logical: 0, nodeId: 'remote-node' })
	})

	test('materializeTimestamp stamps the row version so later stale ops lose', async () => {
		await store.applyRemoteOperation(makeOp({ id: 'op-merge-2' }), {
			forceMaterialize: true,
			materializeData: { title: 'merged@5000' },
			materializeTimestamp: { wallTime: 5000, logical: 0, nodeId: 'remote-node' },
		})

		// An op stamped between the original ts (2000) and the merge stamp (5000)
		// must LOSE to the merged row.
		const stale = makeOp({
			id: 'op-stale',
			nodeId: 'node-b',
			data: { title: 'stale@3000' },
			timestamp: { wallTime: 3000, logical: 0, nodeId: 'node-b' },
			sequenceNumber: 1,
		})
		await store.applyRemoteOperation(stale)

		const record = await store.collection('todos').findById('rec-1')
		expect(record?.title).toBe('merged@5000')
	})

	test('a stale guard makes the apply throw and write NOTHING', async () => {
		// Snapshot the row state, then invalidate it with another write.
		const staleGuard = await store.getRowVersionState('todos', 'rec-1')
		expect(staleGuard).not.toBeNull()

		await store.applyRemoteOperation(
			makeOp({
				id: 'op-interloper',
				nodeId: 'node-c',
				data: { title: 'interloper' },
				timestamp: { wallTime: 4000, logical: 0, nodeId: 'node-c' },
				sequenceNumber: 1,
			}),
		)

		const guarded = makeOp({
			id: 'op-guarded',
			data: { title: 'should not land' },
			timestamp: { wallTime: 9000, logical: 0, nodeId: 'remote-node' },
		})

		await expect(
			store.applyRemoteOperation(guarded, {
				forceMaterialize: true,
				materializeData: { title: 'should not land' },
				guardRowState: staleGuard ?? { version: null, fieldVersions: null },
			}),
		).rejects.toBeInstanceOf(OptimisticLockError)

		// Nothing was written: row untouched, op NOT in the log (retry-safe).
		const record = await store.collection('todos').findById('rec-1')
		expect(record?.title).toBe('interloper')
		const ops = await store.getAllOperations()
		expect(ops.map((o) => o.id)).not.toContain('op-guarded')
	})

	test('a fresh guard lets the apply proceed', async () => {
		const guard = await store.getRowVersionState('todos', 'rec-1')
		const result = await store.applyRemoteOperation(
			makeOp({ id: 'op-fresh-guarded', data: { title: 'landed' } }),
			{
				forceMaterialize: true,
				materializeData: { title: 'landed' },
				guardRowState: guard ?? { version: null, fieldVersions: null },
			},
		)
		expect(result).toBe('applied')
		const record = await store.collection('todos').findById('rec-1')
		expect(record?.title).toBe('landed')
	})

	test('guard expecting an ABSENT row fails when the row appeared meanwhile', async () => {
		const absentGuard = { version: null, fieldVersions: null }
		// rec-2 does not exist when the guard is taken…
		await store.applyRemoteOperation(
			makeOp({
				id: 'op-rec2-insert',
				type: 'insert',
				recordId: 'rec-2',
				data: { title: 'appeared', completed: false },
				previousData: null,
				timestamp: { wallTime: 1500, logical: 0, nodeId: 'node-d' },
				sequenceNumber: 1,
				nodeId: 'node-d',
			}),
		)
		// …but exists by the time the guarded insert runs.
		await expect(
			store.applyRemoteOperation(
				makeOp({
					id: 'op-rec2-guarded',
					type: 'insert',
					recordId: 'rec-2',
					data: { title: 'guarded', completed: true },
					previousData: null,
					timestamp: { wallTime: 2500, logical: 0, nodeId: 'node-e' },
					sequenceNumber: 1,
					nodeId: 'node-e',
				}),
				{ guardRowState: absentGuard },
			),
		).rejects.toBeInstanceOf(OptimisticLockError)
	})
})
