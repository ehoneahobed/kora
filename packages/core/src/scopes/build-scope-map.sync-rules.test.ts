import { describe, expect, test } from 'vitest'
import { defineSchema, t } from '../index'
import { buildScopeMap } from './build-scope-map'

describe('buildScopeMap with schema.sync rules', () => {
	const schema = defineSchema({
		version: 1,
		collections: {
			todos: {
				fields: {
					title: t.string(),
					userId: t.string(),
					orgId: t.string(),
				},
			},
			notes: {
				fields: {
					body: t.string(),
				},
			},
		},
		sync: {
			todos: { where: { userId: true, orgId: true } },
		},
	})

	test('builds scope from sync rules', () => {
		expect(buildScopeMap(schema, { userId: 'user-1', orgId: 'org-9' })).toEqual({
			todos: { userId: 'user-1', orgId: 'org-9' },
		})
	})

	test('omits collections not covered by sync rules in partial sync mode', () => {
		const result = buildScopeMap(schema, { userId: 'user-1' })
		expect(result).not.toHaveProperty('notes')
		expect(Object.keys(result)).toEqual(['todos'])
	})

	test('supports aliased scope keys', () => {
		const aliased = defineSchema({
			version: 1,
			collections: {
				todos: {
					fields: {
						title: t.string(),
						ownerId: t.string(),
					},
				},
			},
			sync: {
				todos: { where: { ownerId: 'userId' } },
			},
		})

		expect(buildScopeMap(aliased, { userId: 'user-42' })).toEqual({
			todos: { ownerId: 'user-42' },
		})
	})
})
