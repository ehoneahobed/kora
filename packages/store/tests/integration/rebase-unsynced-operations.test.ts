import type { Operation, OperationInput } from '@korajs/core'
import { HybridLogicalClock } from '@korajs/core'
import { computeOperationId } from '@korajs/core/internal'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { serializeRowVersion } from '../../src/lww/row-version'
import { Store } from '../../src/store/store'
import { fullSchema } from '../fixtures/test-schema'

/** How far the simulated fast clock runs ahead of real time. */
const CLOCK_AHEAD_MS = 10 * 60_000

/**
 * Re-derive an operation's content-addressed id from its own fields,
 * independently of the rebase implementation, to prove the hash input matches
 * what the original creation path (createOperation) would have produced.
 */
async function deriveId(op: Operation): Promise<string> {
	const input: OperationInput = {
		nodeId: op.nodeId,
		type: op.type,
		collection: op.collection,
		recordId: op.recordId,
		data: op.data,
		previousData: op.previousData,
		sequenceNumber: op.sequenceNumber,
		causalDeps: op.causalDeps,
		schemaVersion: op.schemaVersion,
		...(op.atomicOps !== undefined ? { atomicOps: op.atomicOps } : {}),
	}
	return computeOperationId(input, HybridLogicalClock.serialize(op.timestamp))
}

describe('Integration: rebaseUnsyncedOperations', () => {
	let adapter: BetterSqlite3Adapter
	let store: Store
	let realNow: number

	beforeEach(async () => {
		adapter = new BetterSqlite3Adapter(':memory:')
		store = new Store({ schema: fullSchema, adapter, nodeId: 'rebase-node' })
		await store.open()
		realNow = Date.now()
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await store.close()
	})

	/** Run `fn` with Date.now() pinned to a fixed value, then restore. */
	async function withClockAt<T>(timeMs: number, fn: () => Promise<T>): Promise<T> {
		const spy = vi.spyOn(Date, 'now').mockReturnValue(timeMs)
		try {
			return await fn()
		} finally {
			spy.mockRestore()
		}
	}

	test('re-stamps future ops preserving order, remapping deps, and updating materialized rows', async () => {
		const todos = store.collection('todos')

		// Create ops through the normal store API with a fast clock.
		const future = realNow + CLOCK_AHEAD_MS
		const { insertedIds } = await withClockAt(future, async () => {
			const a = await todos.insert({ title: 'A', tags: ['x'] })
			const b = await todos.insert({ title: 'B' })
			await todos.update(a.id, { title: 'A2', completed: true })
			return { insertedIds: [a.id, b.id] }
		})

		const originalOps = await store.getAllOperations()
		expect(originalOps).toHaveLength(3)
		const originalById = new Map(originalOps.map((op) => [op.id, op]))
		const originalOrder = [...originalOps].sort((x, y) =>
			HybridLogicalClock.compare(x.timestamp, y.timestamp),
		)

		const result = await store.rebaseUnsyncedOperations(
			originalOps.map((op) => op.id),
			realNow,
		)

		expect(result.rebasedCount).toBe(3)
		expect(result.operations).toHaveLength(3)
		expect(result.newMaxTimestamp).not.toBeNull()

		// Order preservation: new ops in the same relative order as the originals,
		// stamped with a shared wallTime and consecutive logical counters.
		for (let i = 0; i < result.operations.length; i++) {
			const newOp = result.operations[i]
			const oldOp = originalOrder[i]
			if (!newOp || !oldOp) throw new Error('missing op')
			expect(result.idMapping[oldOp.id]).toBe(newOp.id)
			expect(newOp.recordId).toBe(oldOp.recordId)
			expect(newOp.timestamp.wallTime).toBe(realNow)
			expect(newOp.timestamp.logical).toBe(i)
			expect(newOp.timestamp.nodeId).toBe(oldOp.nodeId)
			// Ids changed (timestamp is part of the content hash)
			expect(newOp.id).not.toBe(oldOp.id)
			// Data payload untouched
			expect(newOp.data).toEqual(oldOp.data)
			expect(newOp.previousData).toEqual(oldOp.previousData)
			expect(newOp.sequenceNumber).toBe(oldOp.sequenceNumber)
		}

		// Id re-derivation: each new id matches an independent recomputation of
		// the content hash for the new timestamp.
		for (const newOp of result.operations) {
			expect(await deriveId(newOp)).toBe(newOp.id)
		}

		// Causal deps remapped: the update depended on insert ops; all deps must
		// now point at new ids (every dep was itself rebased here).
		const updateOp = result.operations.find((op) => op.type === 'update')
		expect(updateOp).toBeDefined()
		expect(updateOp?.causalDeps.length).toBeGreaterThan(0)
		const newIdSet = new Set(result.operations.map((op) => op.id))
		for (const dep of updateOp?.causalDeps ?? []) {
			expect(newIdSet.has(dep)).toBe(true)
			expect(originalById.has(dep)).toBe(false)
		}

		// The op log now contains only the new ids.
		const logAfter = await store.getAllOperations()
		expect(logAfter.map((op) => op.id).sort()).toEqual([...newIdSet].sort())

		// Materialized rows carry the new version stamps.
		const [recordAId, recordBId] = insertedIds
		const rowA = await adapter.query<{ _version: string; _updated_at: number }>(
			'SELECT _version, _updated_at FROM todos WHERE id = ?',
			[recordAId ?? ''],
		)
		const opsForA = result.operations.filter((op) => op.recordId === recordAId)
		const latestForA = opsForA[opsForA.length - 1]
		if (!latestForA || !rowA[0]) throw new Error('missing row/op for record A')
		expect(rowA[0]._version).toBe(serializeRowVersion(latestForA.timestamp))
		expect(rowA[0]._updated_at).toBe(latestForA.timestamp.wallTime)

		const rowB = await adapter.query<{ _version: string; _updated_at: number }>(
			'SELECT _version, _updated_at FROM todos WHERE id = ?',
			[recordBId ?? ''],
		)
		const insertForB = result.operations.find((op) => op.recordId === recordBId)
		if (!insertForB || !rowB[0]) throw new Error('missing row/op for record B')
		expect(rowB[0]._version).toBe(serializeRowVersion(insertForB.timestamp))

		// Records remain readable with unchanged values.
		const foundA = await todos.findById(recordAId ?? '')
		expect(foundA?.title).toBe('A2')
		expect(foundA?.completed).toBe(true)
	})

	test('base wall time clears the max non-rebased timestamp, and non-rebased ops stay untouched', async () => {
		const todos = store.collection('todos')

		// Non-rebased op slightly in the future relative to correctedNow.
		const keepWall = realNow + 30_000
		const kept = await withClockAt(keepWall, async () => todos.insert({ title: 'kept' }))
		// Rebased op far in the future.
		const moved = await withClockAt(realNow + CLOCK_AHEAD_MS, async () =>
			todos.insert({ title: 'moved' }),
		)

		const allOps = await store.getAllOperations()
		const keptOp = allOps.find((op) => op.recordId === kept.id)
		const movedOp = allOps.find((op) => op.recordId === moved.id)
		if (!keptOp || !movedOp) throw new Error('setup failed')

		const result = await store.rebaseUnsyncedOperations([movedOp.id], realNow)

		// correctedNow < keptOp wallTime, so the base must be keptWall + 1 to keep
		// the rebased op sorting after every op that stays in the log.
		expect(result.rebasedCount).toBe(1)
		expect(result.operations[0]?.timestamp.wallTime).toBe(keptOp.timestamp.wallTime + 1)

		// The non-rebased op keeps its id, timestamp, and materialized version.
		const logAfter = await store.getAllOperations()
		const keptAfter = logAfter.find((op) => op.recordId === kept.id)
		expect(keptAfter?.id).toBe(keptOp.id)
		expect(keptAfter?.timestamp).toEqual(keptOp.timestamp)
		const keptRow = await adapter.query<{ _version: string }>(
			'SELECT _version FROM todos WHERE id = ?',
			[kept.id],
		)
		expect(keptRow[0]?._version).toBe(serializeRowVersion(keptOp.timestamp))
	})

	test('materialized row is left alone when its current version came from a non-rebased op', async () => {
		const todos = store.collection('todos')

		// Future insert (will be rebased) followed by a normal-time update that
		// owns the row's current _version (local updates always stamp the row).
		const record = await withClockAt(realNow + CLOCK_AHEAD_MS, async () =>
			todos.insert({ title: 'v1' }),
		)
		await todos.update(record.id, { title: 'v2' })

		const allOps = await store.getAllOperations()
		const insertOp = allOps.find((op) => op.type === 'insert')
		const updateOp = allOps.find((op) => op.type === 'update')
		if (!insertOp || !updateOp) throw new Error('setup failed')

		await store.rebaseUnsyncedOperations([insertOp.id], realNow)

		// The row version belongs to the (non-rebased) update op and must survive.
		const row = await adapter.query<{ _version: string }>(
			'SELECT _version FROM todos WHERE id = ?',
			[record.id],
		)
		expect(row[0]?._version).toBe(serializeRowVersion(updateOp.timestamp))
	})

	test('empty input and unknown ids are no-ops', async () => {
		const todos = store.collection('todos')
		await todos.insert({ title: 'untouched' })
		const before = await store.getAllOperations()

		const emptyResult = await store.rebaseUnsyncedOperations([], realNow)
		expect(emptyResult).toEqual({
			operations: [],
			idMapping: {},
			rebasedCount: 0,
			newMaxTimestamp: null,
		})

		const unknownResult = await store.rebaseUnsyncedOperations(['does-not-exist'], realNow)
		expect(unknownResult.rebasedCount).toBe(0)

		expect(await store.getAllOperations()).toEqual(before)
	})

	test('advances the store clock so post-rebase writes sort after rebased ops', async () => {
		const todos = store.collection('todos')
		await withClockAt(realNow + CLOCK_AHEAD_MS, async () => todos.insert({ title: 'future' }))
		const ops = await store.getAllOperations()

		const result = await store.rebaseUnsyncedOperations(
			ops.map((op) => op.id),
			realNow,
		)
		const maxTs = result.newMaxTimestamp
		if (!maxTs) throw new Error('expected a rebased timestamp')

		// A brand-new write issued right after the rebase must sort after every
		// rebased operation, or the log's total order would be violated.
		const next = await todos.insert({ title: 'after rebase' })
		const nextOps = await store.getAllOperations()
		const nextOp = nextOps.find((op) => op.recordId === next.id)
		if (!nextOp) throw new Error('missing post-rebase op')
		expect(HybridLogicalClock.compare(nextOp.timestamp, maxTs)).toBeGreaterThan(0)
	})

	test('order preservation holds for many ops with random future timestamps', async () => {
		const todos = store.collection('todos')
		const count = 25
		// Random distinct future offsets create a shuffled creation order.
		const offsets = Array.from({ length: count }, (_, i) => 60_000 + i * 1_000)
		for (let i = offsets.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1))
			const a = offsets[i]
			const b = offsets[j]
			if (a !== undefined && b !== undefined) {
				offsets[i] = b
				offsets[j] = a
			}
		}

		for (const offset of offsets) {
			await withClockAt(realNow + CLOCK_AHEAD_MS + offset, async () =>
				todos.insert({ title: `op-${offset}` }),
			)
		}

		const ops = await store.getAllOperations()
		const originalOrder = [...ops].sort((a, b) =>
			HybridLogicalClock.compare(a.timestamp, b.timestamp),
		)

		const result = await store.rebaseUnsyncedOperations(
			ops.map((op) => op.id),
			realNow,
		)

		expect(result.rebasedCount).toBe(count)
		// New timestamps are strictly increasing and aligned with original order.
		for (let i = 0; i < result.operations.length; i++) {
			const newOp = result.operations[i]
			const oldOp = originalOrder[i]
			if (!newOp || !oldOp) throw new Error('missing op')
			expect(newOp.recordId).toBe(oldOp.recordId)
			if (i > 0) {
				const prev = result.operations[i - 1]
				if (!prev) throw new Error('missing op')
				expect(HybridLogicalClock.compare(newOp.timestamp, prev.timestamp)).toBeGreaterThan(0)
			}
		}
	})

	test('per-field version stamps written by rebased ops are re-stamped too', async () => {
		const todos = store.collection('todos')
		const future = realNow + CLOCK_AHEAD_MS

		// Insert stamps every field; a later update re-stamps only `title`.
		const record = await withClockAt(future, async () => {
			const r = await todos.insert({ title: 'v1', tags: ['x'] })
			await todos.update(r.id, { title: 'v2' })
			return r
		})

		const ops = await store.getAllOperations()
		const result = await store.rebaseUnsyncedOperations(
			ops.map((op) => op.id),
			realNow,
		)

		// Every per-field version on the row must now be one of the NEW serialized
		// stamps — none may still reference a pre-rebase (future) timestamp, or
		// field-level LWW would keep comparing against the uncorrected clock.
		const rows = await adapter.query<{ _field_versions: string }>(
			'SELECT _field_versions FROM todos WHERE id = ?',
			[record.id],
		)
		const fieldVersions = JSON.parse(rows[0]?._field_versions ?? '{}') as Record<string, string>
		expect(Object.keys(fieldVersions).length).toBeGreaterThan(0)

		const newStamps = new Set(result.operations.map((op) => serializeRowVersion(op.timestamp)))
		for (const [field, version] of Object.entries(fieldVersions)) {
			expect(newStamps.has(version), `field "${field}" still has a pre-rebase stamp`).toBe(true)
		}

		// The update op was the last writer of `title`; its NEW stamp must be the
		// one recorded for that field.
		const rebasedUpdate = result.operations.find((op) => op.type === 'update')
		if (!rebasedUpdate) throw new Error('missing rebased update')
		expect(fieldVersions.title).toBe(serializeRowVersion(rebasedUpdate.timestamp))
	})
})
