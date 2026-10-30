import { describe, expect, test } from 'vitest'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import { checkPatchable, compare, matches } from './query-eval'

/**
 * Smoke test of the evaluator at its new home. The differential suite that proves it equal
 * to SQLite stays in `@korajs/store` (`overlay/query-eval.test.ts`), which owns the databases.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		items: { fields: { title: t.string(), n: t.number(), done: t.boolean().default(false) } },
	},
})
const definition = schema.collections.items
if (definition === undefined) throw new Error('fixture collection missing')

const records = [
	{ id: 'a', title: 'Beta', n: 2, done: false },
	{ id: 'b', title: 'Alpha', n: 2, done: true },
	{ id: 'c', title: 'Gamma', n: 5, done: false },
]

describe('shared query evaluator (shared by the store overlay and the server read-through)', () => {
	test('matches equality, operators and $in', () => {
		const range = { where: { n: { $gte: 2, $lt: 5 }, done: false }, orderBy: [] }
		expect(records.filter((r) => matches(range, r)).map((r) => r.id)).toEqual(['a'])
		const ids = { where: { id: { $in: ['a', 'c'] } }, orderBy: [] }
		expect(records.filter((r) => matches(ids, r)).map((r) => r.id)).toEqual(['a', 'c'])
	})

	test('compare orders by key and direction, and ties compare zero', () => {
		const query = {
			where: {},
			orderBy: [
				{ field: 'n', direction: 'desc' as const },
				{ field: 'title', direction: 'asc' as const },
			],
		}
		expect([...records].sort((x, y) => compare(query, x, y)).map((r) => r.id)).toEqual([
			'c',
			'b',
			'a',
		])
		expect(compare({ where: {}, orderBy: [] }, records[0] ?? {}, records[1] ?? {})).toBe(0)
	})

	test('checkPatchable refuses a shape it is not proven on', () => {
		expect(checkPatchable({ where: { n: 2 }, orderBy: [] }, definition).patchable).toBe(true)
		expect(checkPatchable({ where: { missing: 1 }, orderBy: [] }, definition).patchable).toBe(false)
		expect(checkPatchable({ where: {}, orderBy: [], include: ['rel'] }, definition).patchable).toBe(
			false,
		)
	})
})
