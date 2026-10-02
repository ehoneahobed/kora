import { describe, expect, test } from 'vitest'
import { scopeViewKey } from './scope-view-key'

describe('scopeViewKey (SYNC-11)', () => {
	test('no scope is the empty key', () => {
		expect(scopeViewKey(undefined)).toBe('')
		expect(scopeViewKey(null)).toBe('')
	})

	test('key order, undefined entries and $in order do not change the key', () => {
		const a = scopeViewKey({
			todos: { owner: 'alice', orgId: { $in: ['o2', 'o1', 'o2'] } },
			notes: { userId: 'alice' },
		})
		const b = scopeViewKey({
			notes: { userId: 'alice', extra: undefined },
			todos: { orgId: { $in: ['o1', 'o2'] }, owner: 'alice' },
		})
		expect(a).toBe(b)
	})

	test('a JSON round trip keeps the key', () => {
		const scope = { todos: { owner: 'alice', n: 1, flag: true, none: null } }
		expect(scopeViewKey(JSON.parse(JSON.stringify(scope)))).toBe(scopeViewKey(scope))
	})

	test('different values, fields or collections give different keys', () => {
		const base = scopeViewKey({ todos: { owner: 'alice' } })
		expect(scopeViewKey({ todos: { owner: 'bob' } })).not.toBe(base)
		expect(scopeViewKey({ todos: { userId: 'alice' } })).not.toBe(base)
		expect(scopeViewKey({ notes: { owner: 'alice' } })).not.toBe(base)
		expect(scopeViewKey({ todos: { owner: { $in: ['alice'] } } })).not.toBe(base)
		expect(scopeViewKey({ todos: { owner: '1' } })).not.toBe(scopeViewKey({ todos: { owner: 1 } }))
		expect(scopeViewKey({})).not.toBe('')
	})
})
