import { fc } from '@fast-check/vitest'
import { describe, expect, test } from 'vitest'
import type { CollectionRecord, QueryDescriptor } from '../types'
import { applyOverlay, applyOverlayReport } from './apply'
import type { PendingEntry } from './pending-writes'

/**
 * applyOverlay (instant-UI S3, design 5.4): ordering, the `limit` boundary, ties,
 * rollback by recomputation, same-record chains, structural sharing and idempotence. The
 * function is pure, so every case builds a base and a list of entries by hand.
 */
let counter = 0

function row(id: string, fields: Record<string, unknown> = {}): CollectionRecord {
	return { id, createdAt: 1_000, updatedAt: 1_000, n: null, title: id, done: false, ...fields }
}

function entry(
	kind: 'insert' | 'update' | 'delete',
	record: CollectionRecord,
	patch: Record<string, unknown> | null = null,
	previous: Record<string, unknown> | null = null,
): PendingEntry {
	counter += 1
	return {
		writeId: `w${counter}`,
		kind,
		collection: 'items',
		recordId: record.id,
		patch: kind === 'delete' ? null : (patch ?? record),
		previous,
		record,
		dependsOn: null,
		groupId: null,
		state: 'pending',
		retiredAt: null,
		registeredAtMs: 0,
		retiredAtMs: null,
		bytes: 0,
		operationIds: [],
		foreignAtAdd: 0,
		foreignSeqAtAdd: 0,
		foreignActivityAtAdd: 0,
		ancestors: [],
		lookupOperationId: null,
		foldState: null,
	}
}

const insert = (record: CollectionRecord) => entry('insert', record)
const update = (current: CollectionRecord, patch: Record<string, unknown>) =>
	entry(
		'update',
		{ ...current, ...patch },
		patch,
		Object.fromEntries(Object.keys(patch).map((key) => [key, current[key]])),
	)
const remove = (record: CollectionRecord) => entry('delete', record)

const query = (over: Partial<QueryDescriptor> = {}): QueryDescriptor => ({
	collection: 'items',
	where: {},
	orderBy: [],
	...over,
})

const ids = (rows: readonly CollectionRecord[]) => rows.map((r) => r.id)

describe('applyOverlay: ordering', () => {
	const byN = query({ orderBy: [{ field: 'n', direction: 'asc' }] })
	const base = [row('a', { n: 1 }), row('b', { n: 3 }), row('c', { n: 5 })]

	test('an insert lands at its sorted position, ascending and descending', () => {
		expect(ids(applyOverlay(base, [insert(row('x', { n: 4 }))], byN))).toEqual(['a', 'b', 'x', 'c'])
		const desc = query({ orderBy: [{ field: 'n', direction: 'desc' }] })
		const descBase = [...base].reverse()
		expect(ids(applyOverlay(descBase, [insert(row('x', { n: 4 }))], desc))).toEqual([
			'c',
			'x',
			'b',
			'a',
		])
	})

	test('NULL sorts first ascending and last descending, like SQLite', () => {
		expect(ids(applyOverlay(base, [insert(row('x', { n: null }))], byN))).toEqual([
			'x',
			'a',
			'b',
			'c',
		])
		const desc = query({ orderBy: [{ field: 'n', direction: 'desc' }] })
		expect(ids(applyOverlay([...base].reverse(), [insert(row('x', { n: null }))], desc))).toEqual([
			'c',
			'b',
			'a',
			'x',
		])
	})

	test('several entries apply in registration order', () => {
		const rows = applyOverlay(
			base,
			[insert(row('x', { n: 0 })), insert(row('y', { n: 6 })), insert(row('z', { n: 2 }))],
			byN,
		)
		expect(ids(rows)).toEqual(['x', 'a', 'z', 'b', 'c', 'y'])
	})

	test('a row that does not match the where is not inserted; one that stops matching leaves', () => {
		const active = query({ where: { done: false }, orderBy: [{ field: 'n', direction: 'asc' }] })
		expect(ids(applyOverlay(base, [insert(row('x', { n: 2, done: true }))], active))).toEqual([
			'a',
			'b',
			'c',
		])
		const rows = applyOverlay(base, [update(row('b', { n: 3 }), { done: true })], active)
		expect(ids(rows)).toEqual(['a', 'c'])
	})

	test('an update that enters the result is placed by its sort key', () => {
		const active = query({ where: { done: false }, orderBy: [{ field: 'n', direction: 'asc' }] })
		const rows = applyOverlay(
			base,
			[update(row('q', { n: 4, done: true }), { done: false })],
			active,
		)
		expect(ids(rows)).toEqual(['a', 'b', 'q', 'c'])
	})

	test('an update that changes the sort key moves the row', () => {
		const rows = applyOverlay(base, [update(row('a', { n: 1 }), { n: 9 })], byN)
		expect(ids(rows)).toEqual(['b', 'c', 'a'])
		expect(rows[2]?.n).toBe(9)
	})

	test('an update that keeps the sort key replaces in place', () => {
		const rows = applyOverlay(base, [update(row('b', { n: 3 }), { title: 'renamed' })], byN)
		expect(ids(rows)).toEqual(['a', 'b', 'c'])
		expect(rows[1]?.title).toBe('renamed')
	})

	test('text sorts by code point and ids sort as text', () => {
		const byTitle = query({ orderBy: [{ field: 'title', direction: 'asc' }] })
		const text = [row('1', { title: 'Z' }), row('2', { title: 'a' })]
		expect(ids(applyOverlay(text, [insert(row('3', { title: '\u{1F600}' }))], byTitle))).toEqual([
			'1',
			'2',
			'3',
		])
	})
})

describe('applyOverlay: an update of a row that is not in the list', () => {
	const byN = query({ orderBy: [{ field: 'n', direction: 'asc' }] })
	const base = [row('a', { n: 1 }), row('c', { n: 5 })]

	test('a row that matched before and is missing was removed by someone else: it is not resurrected (F21)', () => {
		const ghost = row('g', { n: 3 })
		const result = applyOverlayReport(base, [update(ghost, { title: 'edited' })], byN)
		expect(result.rows).toBe(base)
		expect(result.skipped.map((s) => s.reason)).toEqual(['absent-member'])
	})

	test('beyond a full page it may enter: it was a member, just not one of the first rows', () => {
		const page = query({ orderBy: [{ field: 'n', direction: 'asc' }], limit: 2 })
		const far = row('f', { n: 9 })
		expect(ids(applyOverlay(base, [update(far, { n: 3 })], page))).toEqual(['a', 'f'])
		expect(applyOverlay(base, [update(far, { title: 'x' })], page)).toBe(base)
	})

	test('an update with no recorded previous values cannot be told from a vanished row: skipped', () => {
		const e = entry('update', row('q', { n: 3 }), { n: 3 }, null)
		expect(applyOverlayReport(base, [e], byN).skipped.map((s) => s.reason)).toEqual([
			'absent-member',
		])
	})
})

describe('applyOverlay: no orderBy', () => {
	const base = [row('a'), row('b')]

	test('a new row is appended (largest rowid)', () => {
		expect(ids(applyOverlay(base, [insert(row('x'))], query()))).toEqual(['a', 'b', 'x'])
		expect(
			ids(
				applyOverlay(base, [insert(row('x', { done: false }))], query({ where: { done: false } })),
			),
		).toEqual(['a', 'b', 'x'])
	})

	test('a range or IN condition may return index order: the insert is not patched', () => {
		const ranged = query({ where: { n: { $gt: 0 } } })
		const result = applyOverlayReport(base, [insert(row('x', { n: 5 }))], ranged)
		expect(ids(result.rows)).toEqual(['a', 'b'])
		expect(result.skipped.map((s) => s.reason)).toEqual(['unordered-entry'])
	})

	test('a row entering by update has an unknown rowid position: not patched', () => {
		const result = applyOverlayReport(
			base,
			[update(row('q', { done: true }), { done: false })],
			query({ where: { done: false } }),
		)
		expect(ids(result.rows)).toEqual(['a', 'b'])
		expect(result.skipped.map((s) => s.reason)).toEqual(['unordered-entry'])
	})

	test('an in-place update keeps the position', () => {
		const rows = applyOverlay(base, [update(row('a'), { title: 'new' })], query())
		expect(ids(rows)).toEqual(['a', 'b'])
		expect(rows[0]?.title).toBe('new')
	})
})

describe('applyOverlay: the limit boundary', () => {
	const top2 = query({ orderBy: [{ field: 'n', direction: 'asc' }], limit: 2 })
	const full = [row('a', { n: 1 }), row('c', { n: 5 })]

	test('an insert that sorts inside a full page pushes the last row out', () => {
		expect(ids(applyOverlay(full, [insert(row('x', { n: 3 }))], top2))).toEqual(['a', 'x'])
		expect(ids(applyOverlay(full, [insert(row('x', { n: 0 }))], top2))).toEqual(['x', 'a'])
	})

	test('an insert that sorts past a full page is not shown', () => {
		const result = applyOverlayReport(full, [insert(row('x', { n: 9 }))], top2)
		expect(result.rows).toBe(full)
		expect(result.skipped).toEqual([])
	})

	test('a page that is not full holds every match: inserts always show', () => {
		const short = [row('a', { n: 1 })]
		expect(ids(applyOverlay(short, [insert(row('x', { n: 9 }))], top2))).toEqual(['a', 'x'])
	})

	test('removing a row from a full page is not patched (the next row is not in memory)', () => {
		const result = applyOverlayReport(full, [remove(full[0] as CollectionRecord)], top2)
		expect(ids(result.rows)).toEqual(['a', 'c'])
		expect(result.skipped.map((s) => s.reason)).toEqual(['page-removal'])
	})

	test('an update that makes a row leave a full page is not patched', () => {
		const active = query({
			where: { done: false },
			orderBy: [{ field: 'n', direction: 'asc' }],
			limit: 2,
		})
		const result = applyOverlayReport(
			full,
			[update(full[0] as CollectionRecord, { done: true })],
			active,
		)
		expect(ids(result.rows)).toEqual(['a', 'c'])
		expect(result.skipped.map((s) => s.reason)).toEqual(['page-removal'])
	})

	test('removing from a page that is not full is exact', () => {
		const short = [row('a', { n: 1 })]
		expect(applyOverlay(short, [remove(short[0] as CollectionRecord)], top2)).toEqual([])
	})

	test('a row moving inside a full page ahead of another row is exact; behind all of them it is not', () => {
		const three = query({ orderBy: [{ field: 'n', direction: 'asc' }], limit: 3 })
		const page = [row('a', { n: 1 }), row('b', { n: 3 }), row('c', { n: 5 })]
		// a: 1 -> 4 lands between b and c (strictly before the last remaining row): exact.
		expect(ids(applyOverlay(page, [update(page[0] as CollectionRecord, { n: 4 })], three))).toEqual(
			['b', 'a', 'c'],
		)
		// a: 1 -> 9 would sort after every remaining row, where an unseen row may belong.
		const result = applyOverlayReport(page, [update(page[0] as CollectionRecord, { n: 9 })], three)
		expect(ids(result.rows)).toEqual(['a', 'b', 'c'])
		expect(result.skipped.map((s) => s.reason)).toEqual(['page-move'])
	})

	test('an update that moves a row into a full page pushes the last row out', () => {
		const active = query({
			where: { done: false },
			orderBy: [{ field: 'n', direction: 'asc' }],
			limit: 2,
		})
		const rows = applyOverlay(
			full,
			[update(row('q', { n: 2, done: true }), { done: false })],
			active,
		)
		expect(ids(rows)).toEqual(['a', 'q'])
	})

	test('limit 0 is always empty', () => {
		expect(applyOverlay([], [insert(row('x', { n: 1 }))], query({ limit: 0 }))).toEqual([])
	})

	test('an unordered full page: an appended row falls past it', () => {
		const page = [row('a'), row('b')]
		const result = applyOverlayReport(page, [insert(row('x'))], query({ limit: 2 }))
		expect(result.rows).toBe(page)
		expect(result.skipped).toEqual([])
	})
})

describe('applyOverlay: ties', () => {
	const byN = query({ orderBy: [{ field: 'n', direction: 'asc' }] })
	const base = [row('a', { n: 1 }), row('b', { n: 2 })]

	test('an insert whose key equals a row in the list is not patched', () => {
		const result = applyOverlayReport(base, [insert(row('x', { n: 2 }))], byN)
		expect(result.rows).toBe(base)
		expect(result.skipped.map((s) => s.reason)).toEqual(['tie'])
	})

	test('a tie-break key makes the order total again', () => {
		const total = query({
			orderBy: [
				{ field: 'n', direction: 'asc' },
				{ field: 'id', direction: 'asc' },
			],
		})
		expect(ids(applyOverlay(base, [insert(row('b0', { n: 2 }))], total))).toEqual(['a', 'b', 'b0'])
	})

	test('a moved row that would tie is not patched', () => {
		const result = applyOverlayReport(base, [update(base[0] as CollectionRecord, { n: 2 })], byN)
		expect(ids(result.rows)).toEqual(['a', 'b'])
		expect(result.skipped.map((s) => s.reason)).toEqual(['tie'])
	})

	test('a record with a skipped change skips every later change to it (no value built on a missed step)', () => {
		const tied = insert(row('x', { n: 2 }))
		const later = update(row('x', { n: 2 }), { n: 7 })
		const unrelated = insert(row('y', { n: 8 }))
		const result = applyOverlayReport(base, [tied, later, unrelated], byN)
		expect(ids(result.rows)).toEqual(['a', 'b', 'y'])
		expect(result.skipped.map((s) => s.reason)).toEqual(['tie', 'after-skip'])
	})

	test('the same row staying put is never a tie with itself', () => {
		const rows = applyOverlay(base, [update(base[1] as CollectionRecord, { title: 'z' })], byN)
		expect(rows[1]?.title).toBe('z')
	})
})

describe('applyOverlay: rollback is recomputation', () => {
	const byN = query({ orderBy: [{ field: 'n', direction: 'asc' }] })
	const base = [row('a', { n: 1 }), row('c', { n: 5 })]

	test('with no entries left the display is the base itself', () => {
		const e1 = insert(row('x', { n: 2 }))
		expect(applyOverlay(base, [e1], byN)).not.toBe(base)
		expect(applyOverlay(base, [], byN)).toBe(base)
	})

	test('removing a middle entry yields f(base, the remaining entries)', () => {
		const e1 = insert(row('x', { n: 2 }))
		const e2 = update(row('x', { n: 2 }), { n: 4 })
		const e3 = insert(row('y', { n: 3 }))
		expect(ids(applyOverlay(base, [e1, e2, e3], byN))).toEqual(['a', 'y', 'x', 'c'])
		// e2 rolled back: x keeps n=2, y still lands between.
		expect(ids(applyOverlay(base, [e1, e3], byN))).toEqual(['a', 'x', 'y', 'c'])
		// e1 (and its dependent e2) rolled back: only y remains.
		expect(ids(applyOverlay(base, [e3], byN))).toEqual(['a', 'y', 'c'])
	})
})

describe('applyOverlay: same-record chains', () => {
	const byN = query({ orderBy: [{ field: 'n', direction: 'asc' }] })
	const base = [row('a', { n: 1 })]

	test('insert, update, update shows the last values at the right place', () => {
		const x = row('x', { n: 5 })
		const rows = applyOverlay(
			base,
			[
				insert(x),
				update(x, { title: 'one' }),
				update({ ...x, title: 'one' }, { n: 0, title: 'two' }),
			],
			byN,
		)
		expect(ids(rows)).toEqual(['x', 'a'])
		expect(rows[0]).toMatchObject({ n: 0, title: 'two' })
	})

	test('insert then delete leaves the base content', () => {
		const x = row('x', { n: 5 })
		const rows = applyOverlay(base, [insert(x), remove(x)], byN)
		expect(rows).toEqual(base)
	})

	test('update then delete of a row in the list removes it', () => {
		const a = base[0] as CollectionRecord
		expect(applyOverlay(base, [update(a, { title: 'z' }), remove(a)], byN)).toEqual([])
	})

	test('a delete of a row that is not in the list changes nothing', () => {
		expect(applyOverlay(base, [remove(row('ghost'))], byN)).toBe(base)
	})
})

describe('applyOverlay: structural sharing and idempotence', () => {
	const byN = query({ orderBy: [{ field: 'n', direction: 'asc' }] })
	const base = [row('a', { n: 1 }), row('b', { n: 2 }), row('c', { n: 3 })]

	test('untouched rows keep their identity, the touched row is a new object', () => {
		const rows = applyOverlay(base, [update(base[1] as CollectionRecord, { title: 'new' })], byN)
		expect(rows[0]).toBe(base[0])
		expect(rows[2]).toBe(base[2])
		expect(rows[1]).not.toBe(base[1])
		expect(base[1]?.title).toBe('b')
	})

	test('the base array and its rows are never mutated', () => {
		const snapshot = structuredClone(base)
		applyOverlay(
			base,
			[
				insert(row('x', { n: 0 })),
				update(base[0] as CollectionRecord, { n: 9 }),
				remove(base[2] as CollectionRecord),
			],
			byN,
		)
		expect(base).toEqual(snapshot)
	})

	test('re-applying a write the base already contains changes nothing', () => {
		const e = update(base[1] as CollectionRecord, { title: 'b' })
		const rows = applyOverlay(base, [e], byN)
		expect(rows).toBe(base)
		// An insert whose row is already in the result (a read executed after the commit).
		const again = applyOverlay(base, [insert(base[1] as CollectionRecord)], byN)
		expect(again).toBe(base)
	})

	test('property: applying the same entries twice equals applying them once', () => {
		const field = fc.constantFrom('a', 'b', 'c', 'd')
		const value = fc.option(fc.integer({ min: 0, max: 4 }), { nil: null })
		fc.assert(
			fc.property(
				fc.array(fc.tuple(fc.constantFrom('insert', 'update', 'delete'), field, value), {
					maxLength: 6,
				}),
				(steps) => {
					const entries = steps.map(([kind, id, n]) =>
						kind === 'delete'
							? remove(row(id, { n }))
							: kind === 'insert'
								? insert(row(id, { n }))
								: update(row(id, { n }), { n }),
					)
					const total = query({
						orderBy: [
							{ field: 'n', direction: 'asc' },
							{ field: 'id', direction: 'asc' },
						],
					})
					const start = [row('a', { n: 1 }), row('b', { n: 2 })]
					const once = applyOverlay(start, entries, total)
					// A base that already holds the result (a read issued before the commit but
					// executed after it), with the entries applied again on top.
					expect(applyOverlay(once, entries, total)).toEqual(once)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe('applyOverlay: transactions are applied whole or not at all (S6a, T3)', () => {
	const inGroup = (groupId: string, ...members: PendingEntry[]): PendingEntry[] =>
		members.map((member) => ({ ...member, groupId }))
	const byN = query({ orderBy: [{ field: 'n', direction: 'asc' }] })

	test('a group whose members all place is applied like the same writes one by one', () => {
		const base = [row('a', { n: 1 }), row('b', { n: 3 })]
		const members = [insert(row('x', { n: 2 })), update(row('b', { n: 3 }), { title: 'b2' })]
		expect(applyOverlay(base, inGroup('g1', ...members), byN)).toEqual(
			applyOverlay(base, members, byN),
		)
	})

	test('one member that cannot be placed (a tie) skips every member of its group', () => {
		const base = [row('a', { n: 1 }), row('b', { n: 3 })]
		const group = inGroup(
			'g1',
			insert(row('x', { n: 2 })),
			insert(row('y', { n: 3 })), // ties with b: SQLite's order is not known
		)
		const report = applyOverlayReport(base, group, byN)
		expect(report.rows).toBe(base)
		expect(report.skipped.map((skip) => [skip.recordId, skip.reason])).toEqual([
			['x', 'group'],
			['y', 'group'],
		])
		// Without the group the first insert would have shown.
		expect(
			ids(
				applyOverlay(
					base,
					group.map((one) => ({ ...one, groupId: null })),
					byN,
				),
			),
		).toEqual(['a', 'x', 'b'])
	})

	test('a member leaving a full page (not patchable) keeps the group out of that page', () => {
		const page = query({
			where: { done: false },
			orderBy: [{ field: 'n', direction: 'asc' }],
			limit: 2,
		})
		const base = [row('a', { n: 1 }), row('b', { n: 3 })]
		// The update takes `a` out of a full page (the row behind it is not in memory), the
		// insert would enter the page: alone it would show, with its sibling skipped it must not.
		const group = inGroup(
			'g1',
			update(base[0] as CollectionRecord, { done: true }),
			insert(row('x', { n: 2 })),
		)
		expect(ids(applyOverlay(base, [group[1] as PendingEntry], page))).toEqual(['a', 'x'])
		expect(applyOverlay(base, group, page)).toBe(base)
	})

	test('later writes of a skipped group record are skipped too; other groups are unaffected', () => {
		const base = [row('a', { n: 1 }), row('b', { n: 3 })]
		const skipped = inGroup('g1', insert(row('x', { n: 5 })), insert(row('y', { n: 3 })))
		const after = update(row('x', { n: 5 }), { title: 'x2' })
		const other = inGroup('g2', insert(row('z', { n: 9 })))
		const report = applyOverlayReport(base, [...skipped, after, ...other], byN)
		expect(ids(report.rows)).toEqual(['a', 'b', 'z'])
		expect(report.skipped.map((skip) => skip.reason)).toEqual(['group', 'group', 'after-skip'])
	})

	test('exclusion cascades: a group poisoned by an excluded group is excluded whole', () => {
		const base = [row('a', { n: 1 }), row('b', { n: 3 })]
		const first = inGroup('g1', insert(row('x', { n: 5 })), insert(row('y', { n: 3 })))
		// g2 updates x (poisoned by g1) and inserts w: w must not show alone.
		const second = inGroup(
			'g2',
			update(row('x', { n: 5 }), { title: 'x2' }),
			insert(row('w', { n: 7 })),
		)
		const report = applyOverlayReport(base, [...first, ...second], byN)
		expect(report.rows).toBe(base)
		expect(report.skipped.map((skip) => [skip.recordId, skip.reason])).toEqual([
			['x', 'group'],
			['y', 'group'],
			['x', 'group'],
			['w', 'group'],
		])
	})

	test('property: for every subscription a group is applied whole or not at all', () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 0, maxLength: 5 }),
				fc.array(
					fc.array(fc.tuple(fc.integer({ min: 0, max: 6 }), fc.boolean()), {
						minLength: 1,
						maxLength: 3,
					}),
					{ minLength: 1, maxLength: 4 },
				),
				fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
				(baseNs, groups, limit) => {
					const descriptor = query({
						where: { done: false },
						orderBy: [{ field: 'n', direction: 'asc' }],
						...(limit !== undefined ? { limit } : {}),
					})
					const sortedBase = [...baseNs]
						.sort((x, y) => x - y)
						.map((n, index) => row(`b${index}`, { n }))
						.slice(0, limit ?? Number.POSITIVE_INFINITY)
					let next = 0
					const entries: PendingEntry[] = []
					groups.forEach((members, g) => {
						for (const [n, done] of members) {
							next += 1
							entries.push({ ...insert(row(`g${g}-${next}`, { n, done })), groupId: `g${g}` })
						}
					})
					const shown = new Set(ids(applyOverlay(sortedBase, entries, descriptor)))
					groups.forEach((_, g) => {
						const members = entries.filter((one) => one.groupId === `g${g}`)
						// Members that would enter at all (match the where and fall inside the page
						// when applied alone) are either all shown or all absent.
						const entering = members.filter((member) => member.record.done === false)
						const visible = entering.filter((member) => shown.has(member.recordId))
						if (visible.length > 0 && limit === undefined) {
							expect(visible.length).toBe(entering.length)
						}
						if (visible.length > 0) {
							// Never shown without its siblings that were placeable: no partial group
							// outside the page limit's own truncation.
							const report = applyOverlayReport(sortedBase, entries, descriptor)
							const skippedHere = report.skipped.filter((skip) =>
								members.some((member) => member.writeId === skip.writeId),
							)
							expect(skippedHere).toEqual([])
						}
					})
				},
			),
			{ numRuns: 500 },
		)
	})
})
