import { fc, test as propTest } from '@fast-check/vitest'
import { describe, expect, test } from 'vitest'
import { HybridLogicalClock } from '../clock/hlc'
import type { HLCTimestamp, Operation } from '../types'
import {
	type ReplayOperation,
	expandFieldVersionedOperations,
	mergeArraySet,
	replayFieldVersionsForRecord,
	replayOperationsForRecord,
} from './replay-record'

const element = fc.constantFrom('a', 'b', 'c', 'd', 'e')
const set = fc.uniqueArray(element, { maxLength: 5 })

describe('mergeArraySet', () => {
	test('applies a one-sided removal and a concurrent addition', () => {
		expect(mergeArraySet([], ['urgent', 'billing'], ['urgent'])).toEqual(['billing'])
	})

	test('keeps base order, then additions in a role-independent order', () => {
		expect(mergeArraySet(['c', 'a', 'x'], ['c', 'a', 'b', 'y'], ['c', 'a', 'b'])).toEqual([
			'c',
			'a',
			'x',
			'y',
		])
	})

	propTest.prop([set, set, set])('is commutative, including element order', (base, l, r) => {
		expect(mergeArraySet(l, r, base)).toEqual(mergeArraySet(r, l, base))
	})

	propTest.prop([set, set])(
		'removal beats unchanged: against an untouched side, the editing side wins exactly',
		(base, edited) => {
			const merged = mergeArraySet(edited, base, base)
			expect(new Set(merged)).toEqual(new Set(edited))
			for (const x of base) {
				if (!edited.includes(x)) expect(merged).not.toContain(x)
			}
		},
	)

	propTest.prop([set, set, set])(
		'equals (local ∩ remote) ∪ (local − base) ∪ (remote − base) as a set',
		(base, l, r) => {
			const B = new Set(base)
			const expected = new Set(
				[...new Set([...l, ...r])].filter((x) => (l.includes(x) && r.includes(x)) || !B.has(x)),
			)
			expect(new Set(mergeArraySet(l, r, base))).toEqual(expected)
		},
	)

	propTest.prop([set, set])('is idempotent', (base, side) => {
		const once = mergeArraySet(side, side, base)
		expect(mergeArraySet(once, once, base)).toEqual(once)
	})
})

describe('replayOperationsForRecord array fields', () => {
	const insert: ReplayOperation = { type: 'insert', data: { title: 't', tags: ['urgent'] } }
	const removeUrgent: ReplayOperation = {
		type: 'update',
		data: { tags: [] },
		previousData: { tags: ['urgent'] },
	}
	const addBilling: ReplayOperation = {
		type: 'update',
		data: { tags: ['urgent', 'billing'] },
		previousData: { tags: ['urgent'] },
	}

	test('two concurrent edits from the same base merge as a set, in either HLC order', () => {
		expect(replayOperationsForRecord([insert, removeUrgent, addBilling])?.tags).toEqual(['billing'])
		expect(replayOperationsForRecord([insert, addBilling, removeUrgent])?.tags).toEqual(['billing'])
	})

	test('an update that restates the array unchanged does not undo a removal (NEW-MERGE-1)', () => {
		const saveTitleOnly: ReplayOperation = {
			type: 'update',
			data: { title: 'renamed', tags: ['urgent'] },
			previousData: { title: 't', tags: ['urgent'] },
		}
		const folded = replayOperationsForRecord([insert, removeUrgent, saveTitleOnly])
		expect(folded).toEqual({ title: 'renamed', tags: [] })
	})

	test('a sequential write fast-forwards and keeps the writer’s element order', () => {
		const reorder: ReplayOperation = {
			type: 'update',
			data: { tags: ['z', 'urgent', 'a'] },
			previousData: { tags: ['urgent'] },
		}
		expect(replayOperationsForRecord([insert, reorder])?.tags).toEqual(['z', 'urgent', 'a'])
	})

	test('without previousData an array write stays last-write-wins', () => {
		const legacy: ReplayOperation = { type: 'update', data: { tags: ['x'] } }
		expect(replayOperationsForRecord([insert, removeUrgent, legacy])?.tags).toEqual(['x'])
	})

	test('scalars stay last-write-wins even with previousData', () => {
		const a: ReplayOperation = {
			type: 'update',
			data: { title: 'a' },
			previousData: { title: 't' },
		}
		const b: ReplayOperation = {
			type: 'update',
			data: { title: 'b' },
			previousData: { title: 't' },
		}
		expect(replayOperationsForRecord([insert, a, b])?.title).toBe('b')
	})
})

const at = (wallTime: number, nodeId = 'n'): HLCTimestamp => ({ wallTime, logical: 0, nodeId })

function versioned(type: string, data: Record<string, unknown> | null, ts: HLCTimestamp) {
	return { type, data, timestamp: ts }
}

describe('replayFieldVersionsForRecord (RT-27)', () => {
	test('each field carries its last writer; insert resets; delete hides; update revives', () => {
		const ops = [
			versioned('insert', { title: 'a', body: 'b' }, at(1)),
			versioned('update', { body: 'c' }, at(5)),
			versioned('update', { title: 'd' }, at(3)),
		].sort((a, b) => HybridLogicalClock.compare(a.timestamp, b.timestamp))
		expect(replayFieldVersionsForRecord(ops)).toEqual({
			fields: { title: at(3), body: at(5) },
			created: at(1),
			latest: at(5),
		})
		expect(replayFieldVersionsForRecord([...ops, versioned('delete', null, at(6))])).toBeNull()
		expect(
			replayFieldVersionsForRecord([
				...ops,
				versioned('delete', null, at(6)),
				versioned('update', { title: 'e' }, at(7)),
			])?.fields,
		).toEqual({ title: at(7), body: at(5) })
		// A later insert resets the field set, like the value fold.
		expect(
			replayFieldVersionsForRecord([...ops, versioned('insert', { title: 'x' }, at(8))])?.fields,
		).toEqual({ title: at(8) })
		expect(replayFieldVersionsForRecord([])).toBeNull()
	})

	propTest.prop([
		fc.array(
			fc.record({
				type: fc.constantFrom('insert', 'update', 'delete'),
				fields: fc.subarray(['a', 'b', 'c'], { minLength: 1 }),
				wall: fc.integer({ min: 1, max: 50 }),
			}),
			{ minLength: 1, maxLength: 12 },
		),
	])('the versioned fields are exactly the folded record fields', (spec) => {
		const ops = spec
			.map((s, i) => ({
				type: s.type,
				data: s.type === 'delete' ? null : Object.fromEntries(s.fields.map((f) => [f, `${f}${i}`])),
				timestamp: { wallTime: s.wall, logical: i, nodeId: 'n' },
			}))
			.sort((x, y) => HybridLogicalClock.compare(x.timestamp, y.timestamp))
		const record = replayOperationsForRecord(ops)
		const versions = replayFieldVersionsForRecord(ops)
		expect(versions === null).toBe(record === null)
		if (record && versions) {
			expect(Object.keys(versions.fields).sort()).toEqual(Object.keys(record).sort())
		}
	})
})

describe('expandFieldVersionedOperations (RT-27)', () => {
	function opOf(overrides: Partial<Operation>): Operation {
		return {
			id: 'x',
			nodeId: 'n',
			type: 'update',
			collection: 'todos',
			recordId: 'r',
			data: null,
			previousData: null,
			timestamp: at(1),
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
			...overrides,
		}
	}

	test('a scope entry folds each field at its own version', () => {
		const entry = opOf({
			id: 'entry',
			nodeId: 'kora:scope-entry',
			type: 'insert',
			data: { title: 'title@1', body: 'body@7', owner: 'alice@8' },
			timestamp: at(1),
			fieldVersions: { title: at(1), body: at(7), owner: at(8) },
		})
		// The device's own unsynced edit of title at t5 sits between title@1 and body@7.
		const local = opOf({ id: 'local', data: { title: 'title@5' }, timestamp: at(5, 'd') })
		const ops = expandFieldVersionedOperations([entry, local])
		expect(ops.map((o) => o.type)).toEqual(['insert', 'update', 'update', 'update'])
		expect(ops.every((o) => o.fieldVersions === undefined)).toBe(true)
		expect(replayOperationsForRecord(ops)).toEqual({
			title: 'title@5',
			body: 'body@7',
			owner: 'alice@8',
		})
		// Folding the entry as one insert at its newest version would lose the edit.
		const naive: Operation[] = [local, { ...entry, timestamp: at(8) }]
		expect(replayOperationsForRecord(naive)?.title).toBe('title@1')
	})

	test('other operations pass through, sorted', () => {
		const a = opOf({ id: 'a', timestamp: at(3) })
		const b = opOf({ id: 'b', type: 'insert', data: { t: 1 }, timestamp: at(2) })
		expect(expandFieldVersionedOperations([a, b]).map((o) => o.id)).toEqual(['b', 'a'])
	})
})
