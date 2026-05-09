import { describe, expect, test } from 'vitest'
import { defineSchema, t } from '../index'
import { buildScopeMap } from './build-scope-map'

const schema = defineSchema({
	version: 1,
	collections: {
		sales: {
			fields: {
				total: t.number(),
				orgId: t.string(),
				storeId: t.string(),
			},
			scope: ['orgId', 'storeId'],
		},
		products: {
			fields: {
				name: t.string(),
				orgId: t.string(),
			},
			scope: ['orgId'],
		},
		settings: {
			fields: {
				key: t.string(),
				value: t.string(),
			},
			// No scope — visible to all
		},
	},
})

describe('buildScopeMap', () => {
	test('builds per-collection scope from flat values', () => {
		const result = buildScopeMap(schema, { orgId: 'org-123', storeId: 'store-456' })
		expect(result).toEqual({
			sales: { orgId: 'org-123', storeId: 'store-456' },
			products: { orgId: 'org-123' },
			settings: {},
		})
	})

	test('unscoped collections get empty scope (no filter)', () => {
		const result = buildScopeMap(schema, { orgId: 'org-123' })
		expect(result.settings).toEqual({})
	})

	test('missing scope values are omitted from collection scope', () => {
		const result = buildScopeMap(schema, { orgId: 'org-123' })
		// storeId not provided, so sales scope only has orgId
		expect(result.sales).toEqual({ orgId: 'org-123' })
	})

	test('empty scope values produces all-empty scopes', () => {
		const result = buildScopeMap(schema, {})
		expect(result.sales).toEqual({})
		expect(result.products).toEqual({})
		expect(result.settings).toEqual({})
	})

	test('extra scope values are ignored', () => {
		const result = buildScopeMap(schema, {
			orgId: 'org-123',
			storeId: 'store-456',
			unknownField: 'val',
		})
		// unknownField is not a scope field on any collection
		expect(result.sales).toEqual({ orgId: 'org-123', storeId: 'store-456' })
		expect(result.products).toEqual({ orgId: 'org-123' })
	})

	test('includes all collections in result', () => {
		const result = buildScopeMap(schema, { orgId: 'org-123' })
		expect(Object.keys(result).sort()).toEqual(['products', 'sales', 'settings'])
	})
})
