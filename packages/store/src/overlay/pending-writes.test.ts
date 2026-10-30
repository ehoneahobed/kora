import { describe, expect, test, vi } from 'vitest'
import type { CollectionRecord } from '../types'
import { type OverlayEvent, PendingWrites, type PendingWritesOptions } from './pending-writes'
import type { PredictedChange } from './predict'

/** Registry lifecycle (instant-UI S2): entries, epochs, caps, TTL, events, dependency chain, row cache. */

function record(id: string, extra: Record<string, unknown> = {}): CollectionRecord {
	return { id, createdAt: 10, updatedAt: 10, title: id, ...extra }
}

function change(
	kind: PredictedChange['kind'],
	id: string,
	extra: Record<string, unknown> = {},
	collection = 'todos',
): PredictedChange {
	const rec = record(id, extra)
	return {
		predicted: true,
		kind,
		collection,
		recordId: id,
		patch: kind === 'delete' ? null : { ...extra },
		record: rec,
	}
}

function make(options: PendingWritesOptions = {}) {
	let clock = 0
	const events: OverlayEvent[] = []
	const registry = new PendingWrites({
		now: () => clock,
		onEvent: (event) => events.push(event),
		...options,
	})
	return {
		registry,
		events,
		advance(ms: number) {
			clock += ms
		},
	}
}

function added(registry: PendingWrites, c: PredictedChange, dependsOn: string | null = null) {
	const result = registry.add(c, { dependsOn })
	if (!result.ok) throw new Error(`refused: ${result.reason}`)
	return result.entry
}

describe('PendingWrites lifecycle', () => {
	test('add registers a pending entry and reports store:write-pending', () => {
		const { registry, events } = make()
		const entry = added(registry, change('insert', 'a'))
		expect(entry).toMatchObject({ kind: 'insert', state: 'pending', retiredAt: null })
		expect(registry.pendingCount).toBe(1)
		expect(registry.epoch).toBe(0)
		expect(events).toEqual([
			{
				type: 'store:write-pending',
				writeId: entry.writeId,
				collection: 'todos',
				recordIds: ['a'],
				kind: 'insert',
				predicted: true,
			},
		])
	})

	test('commit retires the entry with the next epoch and keeps it shown', () => {
		const { registry, events, advance } = make()
		const first = added(registry, change('insert', 'a'))
		advance(7)
		const retired = registry.commit(first.writeId, {
			record: record('a', { updatedAt: 99 }),
			operationIds: ['op1'],
		})
		expect(retired).toMatchObject({ state: 'committed', retiredAt: 1 })
		expect(registry.epoch).toBe(1)
		// Not pending any more, still held until subscriptions have re-read (F3).
		expect(registry.pendingCount).toBe(0)
		expect(registry.settlingCount).toBe(1)
		expect(registry.get(first.writeId)?.record.updatedAt).toBe(99)
		const second = added(registry, change('insert', 'b'))
		registry.commit(second.writeId)
		expect(registry.get(second.writeId)?.retiredAt).toBe(2)
		expect(events.filter((event) => event.type === 'store:write-settled')[0]).toEqual({
			type: 'store:write-settled',
			writeId: first.writeId,
			collection: 'todos',
			outcome: 'committed',
			operationIds: ['op1'],
			pendingMs: 7,
		})
	})

	test('an entry applies to a read iff retiredAt is null or after the read was issued (5.5, F6)', () => {
		const { registry } = make()
		const e = added(registry, change('insert', 'a'))
		// Read issued before the commit (epoch 0): the write may not be in it.
		expect(registry.applicable('todos', 0).map((x) => x.writeId)).toEqual([e.writeId])
		registry.commit(e.writeId)
		expect(registry.applicable('todos', 0).map((x) => x.writeId)).toEqual([e.writeId])
		// Read issued after the commit (epoch 1): it contains the write.
		expect(registry.applicable('todos', 1)).toEqual([])
		// Other collections are never involved.
		expect(registry.applicable('notes', 0)).toEqual([])
	})

	test('applicable entries come back in registration order', () => {
		const { registry } = make()
		const ids = ['a', 'b', 'c'].map((id) => added(registry, change('insert', id)).writeId)
		registry.commit(ids[1] as string)
		expect(registry.applicable('todos', 0).map((x) => x.writeId)).toEqual(ids)
	})

	test('settleCollection drops committed entries contained in a read issued at or after their epoch', () => {
		const { registry } = make()
		const a = added(registry, change('insert', 'a'))
		const b = added(registry, change('insert', 'b'))
		registry.commit(a.writeId)
		registry.commit(b.writeId)
		// A read issued at epoch 1 contains a (retired at 1) but not b (retired at 2).
		const dropped = registry.settleCollection('todos', 1)
		expect(dropped.map((x) => x.writeId)).toEqual([a.writeId])
		expect(registry.list().map((x) => x.writeId)).toEqual([b.writeId])
		expect(registry.settleCollection('todos', 2).map((x) => x.writeId)).toEqual([b.writeId])
		expect(registry.list()).toEqual([])
		expect(registry.bytes).toBe(0)
	})

	test('settleCollection never drops a pending entry or another collection', () => {
		const { registry } = make()
		const pending = added(registry, change('insert', 'p'))
		const other = added(registry, change('insert', 'o', {}, 'notes'))
		registry.commit(other.writeId)
		expect(registry.settleCollection('todos', 99)).toEqual([])
		expect(registry.get(pending.writeId)).toBeDefined()
		expect(registry.get(other.writeId)).toBeDefined()
	})

	test('rollback removes the entry and reports it', () => {
		const { registry, events, advance } = make()
		const a = added(registry, change('insert', 'a'))
		advance(3)
		expect(registry.rollback(a.writeId).map((x) => x.writeId)).toEqual([a.writeId])
		expect(registry.list()).toEqual([])
		expect(registry.pendingCount).toBe(0)
		expect(registry.bytes).toBe(0)
		expect(events.at(-1)).toEqual({
			type: 'store:write-settled',
			writeId: a.writeId,
			collection: 'todos',
			outcome: 'rolled-back',
			pendingMs: 3,
		})
	})

	test('rollback is a no-op for an unknown or committed write', () => {
		const { registry } = make()
		const a = added(registry, change('insert', 'a'))
		registry.commit(a.writeId)
		expect(registry.rollback(a.writeId)).toEqual([])
		expect(registry.rollback('nope')).toEqual([])
		expect(registry.get(a.writeId)?.state).toBe('committed')
	})

	test('a middle rollback removes its dependents, transitively, and leaves the rest (F10)', () => {
		const { registry } = make()
		const insert = added(registry, change('insert', 'a'))
		const first = added(registry, change('update', 'a', { n: 1 }), insert.writeId)
		const second = added(registry, change('update', 'a', { n: 2 }), first.writeId)
		const unrelated = added(registry, change('insert', 'z'))
		const removed = registry.rollback(first.writeId)
		expect(removed.map((x) => x.writeId)).toEqual([first.writeId, second.writeId])
		expect(registry.list().map((x) => x.writeId)).toEqual([insert.writeId, unrelated.writeId])
	})

	test('a dependent that already committed is not rolled back with its parent', () => {
		const { registry } = make()
		const parent = added(registry, change('insert', 'a'))
		const child = added(registry, change('update', 'a', { n: 1 }), parent.writeId)
		registry.commit(child.writeId)
		const removed = registry.rollback(parent.writeId)
		expect(removed.map((x) => x.writeId)).toEqual([parent.writeId])
		expect(registry.get(child.writeId)?.state).toBe('committed')
	})

	test('markUnknown keeps the entry shown and counted as not committed', () => {
		const { registry, events } = make()
		const a = added(registry, change('insert', 'a'))
		expect(registry.markUnknown(a.writeId)?.state).toBe('unknown')
		expect(registry.pendingCount).toBe(1)
		expect(registry.applicable('todos', 0)).toHaveLength(1)
		expect(events.at(-1)).toMatchObject({ type: 'store:write-settled', outcome: 'unknown' })
		// It can still commit, or roll back, once decided.
		expect(registry.commit(a.writeId)?.state).toBe('committed')
		expect(registry.markUnknown(a.writeId)).toBeNull()
	})
})

describe('PendingWrites time limits', () => {
	test('an entry pending past the TTL becomes unknown and stays applied', () => {
		const { registry, advance } = make({ pendingTtlMs: 1_000 })
		const a = added(registry, change('insert', 'a'))
		advance(999)
		expect(registry.sweep().expired).toEqual([])
		advance(1)
		const { expired } = registry.sweep()
		expect(expired.map((x) => x.writeId)).toEqual([a.writeId])
		expect(registry.get(a.writeId)?.state).toBe('unknown')
		expect(registry.applicable('todos', 0)).toHaveLength(1)
		// Already unknown: not reported twice.
		expect(registry.sweep().expired).toEqual([])
	})

	test('a committed entry older than settleMs is reported as lagging, then dropped by the caller', () => {
		const { registry, advance } = make({ settleMs: 500 })
		const a = added(registry, change('insert', 'a'))
		registry.commit(a.writeId)
		advance(499)
		expect(registry.sweep().lagging).toEqual([])
		advance(1)
		const { lagging } = registry.sweep()
		expect(lagging.map((x) => x.writeId)).toEqual([a.writeId])
		registry.drop(lagging)
		expect(registry.list()).toEqual([])
		expect(registry.bytes).toBe(0)
	})

	test('drop ignores entries that are not committed', () => {
		const { registry } = make()
		const a = added(registry, change('insert', 'a'))
		registry.drop([a])
		expect(registry.get(a.writeId)).toBeDefined()
	})
})

describe('PendingWrites caps (I8)', () => {
	test('writes beyond maxPendingWrites are refused, counted, and nothing is dropped', () => {
		const { registry, events } = make({ maxPendingWrites: 2 })
		const a = added(registry, change('insert', 'a'))
		added(registry, change('insert', 'b'))
		const refused = registry.add(change('insert', 'c'))
		expect(refused).toEqual({ ok: false, reason: 'pending-cap' })
		expect(registry.misses.get('pending-cap')).toBe(1)
		expect(registry.pendingCount).toBe(2)
		expect(registry.get(a.writeId)).toBeDefined()
		expect(events.at(-1)).toMatchObject({
			type: 'store:write-pending',
			predicted: false,
			reason: 'pending-cap',
			recordIds: ['c'],
		})
	})

	test('a committed entry no longer counts against maxPendingWrites', () => {
		const { registry } = make({ maxPendingWrites: 1 })
		const a = added(registry, change('insert', 'a'))
		expect(registry.add(change('insert', 'b')).ok).toBe(false)
		registry.commit(a.writeId)
		expect(registry.add(change('insert', 'b')).ok).toBe(true)
	})

	test('writes beyond maxPendingBytes are refused, and bytes are returned on removal', () => {
		const { registry } = make({ maxPendingBytes: 400 })
		const big = 'x'.repeat(100)
		const a = added(registry, change('insert', 'a', { big }))
		const used = registry.bytes
		expect(used).toBeGreaterThan(100)
		expect(registry.add(change('insert', 'b', { big: big.repeat(3) }))).toEqual({
			ok: false,
			reason: 'bytes-cap',
		})
		expect(registry.bytes).toBe(used)
		registry.rollback(a.writeId)
		expect(registry.bytes).toBe(0)
		expect(registry.add(change('insert', 'b', { big })).ok).toBe(true)
	})

	test('a write touching more than maxRecordsPerWrite records is refused', () => {
		const { registry } = make({ maxRecordsPerWrite: 100 })
		expect(registry.add(change('insert', 'a'), { recordCount: 101 })).toEqual({
			ok: false,
			reason: 'records-cap',
		})
		expect(registry.add(change('insert', 'a'), { recordCount: 100 }).ok).toBe(true)
	})

	test('defaults match the design (256 entries, 8 MiB, 100 records, 2 s, 60 s, 512 rows)', () => {
		const { registry } = make()
		expect(registry.limits).toEqual({
			maxPendingWrites: 256,
			maxPendingBytes: 8 * 1024 * 1024,
			maxRecordsPerWrite: 100,
			settleMs: 2_000,
			pendingTtlMs: 60_000,
			rowCacheSize: 512,
		})
	})
})

describe('PendingWrites base lookup and committed-row cache (5.6)', () => {
	test('the newest entry for a record is its base, in a pending chain', () => {
		const { registry } = make()
		const insert = added(registry, change('insert', 'a', { n: 0 }))
		expect(registry.baseFor('todos', 'a')).toMatchObject({
			found: 'record',
			source: 'pending',
			record: { n: 0 },
		})
		const update = added(registry, change('update', 'a', { n: 5 }), insert.writeId)
		expect(registry.baseFor('todos', 'a')).toMatchObject({ record: { n: 5 } })
		expect(registry.pendingFor('todos', 'a')?.writeId).toBe(update.writeId)
		// Rolling the update back exposes the insert again.
		registry.rollback(update.writeId)
		expect(registry.baseFor('todos', 'a')).toMatchObject({ record: { n: 0 } })
	})

	test('a pending delete makes the record deleted', () => {
		const { registry } = make()
		added(registry, change('delete', 'a'))
		expect(registry.baseFor('todos', 'a')).toEqual({ found: 'deleted' })
	})

	test('a commit fills the cache with the committed record and the base survives settling', () => {
		const { registry } = make()
		const a = added(registry, change('insert', 'a', { n: 1 }))
		registry.commit(a.writeId, { record: record('a', { n: 1, updatedAt: 77 }) })
		registry.settleCollection('todos', 1)
		expect(registry.list()).toEqual([])
		expect(registry.baseFor('todos', 'a')).toMatchObject({
			found: 'record',
			source: 'cache',
			record: { updatedAt: 77 },
		})
		expect(registry.wallTimeFloor()).toBe(77)
	})

	test('a committed delete removes the record from the cache', () => {
		const { registry } = make()
		registry.cacheRecord('todos', record('a'))
		const del = added(registry, change('delete', 'a'))
		registry.commit(del.writeId)
		registry.settleCollection('todos', 1)
		expect(registry.baseFor('todos', 'a')).toEqual({ found: 'none' })
	})

	test('the cache evicts the least recently used row beyond rowCacheSize', () => {
		const { registry } = make({ rowCacheSize: 2 })
		registry.cacheRecord('todos', record('a'))
		registry.cacheRecord('todos', record('b'))
		// Touch a, so b is the oldest.
		expect(registry.baseFor('todos', 'a').found).toBe('record')
		registry.cacheRecord('todos', record('c'))
		expect(registry.cachedRows).toBe(2)
		expect(registry.baseFor('todos', 'b')).toEqual({ found: 'none' })
		expect(registry.baseFor('todos', 'a').found).toBe('record')
		expect(registry.baseFor('todos', 'c').found).toBe('record')
	})

	test('invalidate forgets one record, some records, or a whole collection (F21)', () => {
		const { registry } = make()
		for (const id of ['a', 'b', 'c']) registry.cacheRecord('todos', record(id))
		registry.cacheRecord('notes', record('n'))
		registry.invalidate('todos', ['a'])
		expect(registry.baseFor('todos', 'a').found).toBe('none')
		expect(registry.baseFor('todos', 'b').found).toBe('record')
		registry.invalidate('todos')
		expect(registry.baseFor('todos', 'b').found).toBe('none')
		expect(registry.baseFor('todos', 'c').found).toBe('none')
		expect(registry.baseFor('notes', 'n').found).toBe('record')
	})

	test('clear drops entries, cache and bytes (I12) without events', () => {
		const { registry, events } = make()
		const a = added(registry, change('insert', 'a'))
		registry.cacheRecord('todos', record('x'))
		const before = events.length
		expect(registry.clear().map((x) => x.writeId)).toEqual([a.writeId])
		expect(registry.list()).toEqual([])
		expect(registry.cachedRows).toBe(0)
		expect(registry.bytes).toBe(0)
		expect(events).toHaveLength(before)
	})
})

describe('PendingWrites events', () => {
	test('a throwing listener never affects the registry', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
		const registry = new PendingWrites({
			onEvent: () => {
				throw new Error('listener bug')
			},
		})
		const a = registry.add(change('insert', 'a'))
		expect(a.ok).toBe(true)
		expect(registry.pendingCount).toBe(1)
		spy.mockRestore()
	})

	test('divergence is reported with field names only', () => {
		const { registry, events } = make()
		const a = added(registry, change('insert', 'a'))
		registry.reportDivergence(a, [])
		registry.reportDivergence(a, ['title'])
		expect(events.filter((e) => e.type === 'store:overlay-diverged')).toEqual([
			{
				type: 'store:overlay-diverged',
				writeId: a.writeId,
				collection: 'todos',
				fields: ['title'],
			},
		])
	})

	test('noteMiss allocates ids and counts by reason', () => {
		const { registry } = make()
		registry.noteMiss('update', 'todos', ['a'], 'atomic-op')
		registry.noteMiss('update', 'todos', ['b'], 'atomic-op')
		registry.noteMiss('delete', 'todos', ['c'], 'cascade-target')
		expect(registry.misses.get('atomic-op')).toBe(2)
		expect(registry.misses.get('cascade-target')).toBe(1)
		expect(registry.pendingCount).toBe(0)
	})
})

describe('PendingWrites entry groups (S6a transactions)', () => {
	function group(
		registry: PendingWrites,
		changes: PredictedChange[],
		dependsOn: Array<string | null> = [],
	) {
		const result = registry.addGroup(
			changes.map((one, index) => ({ change: one, dependsOn: dependsOn[index] ?? null })),
		)
		if (!result.ok) throw new Error(`refused: ${result.reason}`)
		return result
	}

	test('addGroup registers every member with one group id and reports ONE write-pending (T1, T7)', () => {
		const { registry, events } = make()
		const { groupId, entries } = group(registry, [
			change('insert', 'a'),
			change('update', 'b', { title: 'b2' }),
			change('insert', 'l', {}, 'lists'),
		])
		expect(entries.map((entry) => entry.groupId)).toEqual([groupId, groupId, groupId])
		expect(new Set(entries.map((entry) => entry.writeId)).size).toBe(3)
		expect(registry.pendingCount).toBe(3)
		expect(events).toEqual([
			{
				type: 'store:write-pending',
				writeId: groupId,
				collection: 'todos',
				collections: ['todos', 'lists'],
				recordIds: ['a', 'b', 'l'],
				kind: 'transaction',
				predicted: true,
			},
		])
	})

	test('one change notification covers the whole group', () => {
		const { registry } = make()
		const changes: string[][] = []
		registry.onChange((one) => changes.push([one.kind, ...one.collections]))
		group(registry, [change('insert', 'a'), change('insert', 'l', {}, 'lists')])
		expect(changes).toEqual([['added', 'todos', 'lists']])
	})

	test('caps are checked for the whole group: refused whole, nothing registered (I8, T1)', () => {
		const cases: Array<[PendingWritesOptions, string]> = [
			[{ maxRecordsPerWrite: 2 }, 'records-cap'],
			[{ maxPendingWrites: 2 }, 'pending-cap'],
			[{ maxPendingBytes: 120 }, 'bytes-cap'],
		]
		for (const [limits, reason] of cases) {
			const { registry, events } = make(limits)
			const result = registry.addGroup(
				['a', 'b', 'c'].map((id) => ({ change: change('insert', id), dependsOn: null })),
			)
			expect(result).toEqual({ ok: false, reason })
			expect(registry.list()).toEqual([])
			expect(registry.bytes).toBe(0)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ kind: 'transaction', predicted: false, reason })
		}
	})

	test('a group the pending headroom cannot hold whole is refused; nothing already there is dropped', () => {
		const { registry } = make({ maxPendingWrites: 3 })
		added(registry, change('insert', 'x'))
		const result = registry.addGroup(
			['a', 'b', 'c'].map((id) => ({ change: change('insert', id), dependsOn: null })),
		)
		expect(result).toEqual({ ok: false, reason: 'pending-cap' })
		expect(registry.list().map((entry) => entry.recordId)).toEqual(['x'])
	})

	test('commitGroup retires every member with ONE epoch and reports one settled event (T2)', () => {
		const { registry, events, advance } = make()
		const { groupId, entries } = group(registry, [change('insert', 'a'), change('insert', 'b')])
		advance(5)
		events.length = 0
		const [a, b] = entries
		const retired = registry.commitGroup(
			groupId,
			new Map([
				[a?.writeId ?? '', { record: record('a', { updatedAt: 50 }), operationIds: ['op-a'] }],
				[b?.writeId ?? '', { record: record('b', { updatedAt: 50 }), operationIds: ['op-b'] }],
			]),
		)
		expect(retired.map((entry) => entry.retiredAt)).toEqual([1, 1])
		expect(registry.epoch).toBe(1)
		expect(registry.list().every((entry) => entry.state === 'committed')).toBe(true)
		expect(events).toEqual([
			{
				type: 'store:write-settled',
				writeId: groupId,
				collection: 'todos',
				collections: ['todos'],
				outcome: 'committed',
				operationIds: ['op-a', 'op-b'],
				pendingMs: 5,
			},
		])
		// A read issued before the commit gets the group, one issued at or after it does not.
		expect(registry.applicable('todos', 0)).toHaveLength(2)
		expect(registry.applicable('todos', 1)).toHaveLength(0)
		expect(registry.ownsOperation('op-b')).toBe(true)
	})

	test('committing one member commits the group (the M2 lookup path)', () => {
		const { registry } = make()
		const { entries } = group(registry, [change('insert', 'a'), change('insert', 'b')])
		const [a] = entries
		registry.commit(a?.writeId ?? '', { operationIds: ['op-a'] })
		expect(registry.list().map((entry) => [entry.state, entry.retiredAt])).toEqual([
			['committed', 1],
			['committed', 1],
		])
	})

	test('rolling back any member removes the whole group, with one rolled-back event (T2, T7)', () => {
		const { registry, events } = make()
		added(registry, change('insert', 'kept'))
		const { groupId, entries } = group(registry, [
			change('insert', 'a'),
			change('insert', 'l', {}, 'lists'),
		])
		events.length = 0
		const removed = registry.rollback(entries[1]?.writeId ?? '')
		expect(removed.map((entry) => entry.recordId).sort()).toEqual(['a', 'l'])
		expect(registry.list().map((entry) => entry.recordId)).toEqual(['kept'])
		expect(events).toEqual([
			{
				type: 'store:write-settled',
				writeId: groupId,
				collection: 'lists',
				collections: ['lists', 'todos'],
				outcome: 'rolled-back',
				pendingMs: 0,
			},
		])
	})

	test('the rollback closure: dependents of any member, and whole groups holding a dependent (T4)', () => {
		const { registry } = make()
		const root = added(registry, change('insert', 'r'))
		// G1 derives one member from the root; G2 derives a member from G1's other member; a
		// single write derives from G2; an unrelated group stays.
		const g1 = group(
			registry,
			[change('update', 'r', { title: 'r2' }), change('insert', 'x')],
			[root.writeId],
		)
		const g2 = group(
			registry,
			[change('insert', 'y'), change('update', 'x', { title: 'x2' })],
			[null, g1.entries[1]?.writeId ?? null],
		)
		added(registry, change('update', 'y', { title: 'y2' }), g2.entries[0]?.writeId ?? null)
		const other = group(registry, [change('insert', 'z')])
		const removed = registry.rollback(root.writeId)
		expect(removed.map((entry) => entry.recordId)).toEqual(['r', 'r', 'x', 'y', 'x', 'y'])
		expect(registry.list().map((entry) => entry.writeId)).toEqual(
			other.entries.map((entry) => entry.writeId),
		)
	})

	test('a committed group is never rolled back by a later failure of what it derived from', () => {
		const { registry } = make()
		const root = added(registry, change('insert', 'r'))
		const g = group(registry, [change('update', 'r', { title: 'r2' })], [root.writeId])
		registry.commitGroup(g.groupId)
		const removed = registry.rollback(root.writeId)
		expect(removed.map((entry) => entry.writeId)).toEqual([root.writeId])
		expect(registry.list().map((entry) => entry.state)).toEqual(['committed'])
	})

	test('markUnknown of a member marks the whole group with one event; the TTL expires a group together', () => {
		const { registry, events } = make({ pendingTtlMs: 100 })
		const g = group(registry, [change('insert', 'a'), change('insert', 'b')])
		events.length = 0
		registry.markUnknown(g.entries[1]?.writeId ?? '', 'op-witness')
		expect(registry.list().map((entry) => [entry.state, entry.lookupOperationId])).toEqual([
			['unknown', 'op-witness'],
			['unknown', 'op-witness'],
		])
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({ writeId: g.groupId, outcome: 'unknown' })

		const second = make({ pendingTtlMs: 100 })
		const h = group(second.registry, [change('insert', 'a'), change('insert', 'b')])
		second.advance(100)
		second.events.length = 0
		const swept = second.registry.sweep()
		expect(swept.expired).toHaveLength(1)
		expect(second.registry.groupMembers(h.groupId).map((entry) => entry.state)).toEqual([
			'unknown',
			'unknown',
		])
		expect(second.events).toHaveLength(1)
	})

	test('the newest member of a group is the base of a later write of its record', () => {
		const { registry } = make()
		group(registry, [
			change('insert', 'a', { title: 'one' }),
			change('update', 'a', { title: 'two' }),
		])
		const base = registry.baseFor('todos', 'a')
		expect(base).toMatchObject({ found: 'record', source: 'pending' })
		expect(registry.pendingFor('todos', 'a')?.groupId).not.toBeNull()
	})

	test('noteGroupMiss counts one miss for the group', () => {
		const { registry, events } = make()
		registry.noteGroupMiss(['todos', 'lists'], ['a', 'b'], 'atomic-op')
		expect(registry.misses.get('atomic-op')).toBe(1)
		expect(events).toEqual([
			{
				type: 'store:write-pending',
				writeId: 'w1',
				collection: 'todos',
				collections: ['todos', 'lists'],
				recordIds: ['a', 'b'],
				kind: 'transaction',
				predicted: false,
				reason: 'atomic-op',
			},
		])
	})
})
