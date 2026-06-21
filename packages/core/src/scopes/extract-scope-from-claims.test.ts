import { describe, expect, test } from 'vitest'
import { defineSchema, t } from '../index'
import { collectSchemaScopeFields, extractScopeValuesFromClaims } from './extract-scope-from-claims'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				userId: t.string(),
				orgId: t.string(),
			},
			scope: ['userId', 'orgId'],
		},
		notes: {
			fields: {
				body: t.string(),
			},
		},
	},
})

describe('collectSchemaScopeFields', () => {
	test('returns unique scope fields across collections', () => {
		expect(collectSchemaScopeFields(schema).sort()).toEqual(['orgId', 'userId'])
	})
})

describe('extractScopeValuesFromClaims', () => {
	test('reads top-level claims matching scope field names', () => {
		const values = extractScopeValuesFromClaims(schema, {
			sub: 'user-1',
			orgId: 'org-99',
		})
		expect(values).toEqual({ userId: 'user-1', orgId: 'org-99' })
	})

	test('reads nested scope object', () => {
		const values = extractScopeValuesFromClaims(schema, {
			sub: 'user-1',
			scope: { orgId: 'org-42' },
		})
		expect(values).toEqual({ userId: 'user-1', orgId: 'org-42' })
	})

	test('top-level claim wins over nested scope object', () => {
		const values = extractScopeValuesFromClaims(schema, {
			sub: 'user-1',
			orgId: 'org-top',
			scope: { orgId: 'org-nested' },
		})
		expect(values).toEqual({ userId: 'user-1', orgId: 'org-top' })
	})

	test('returns empty object when schema has no scope fields', () => {
		const noScopeSchema = defineSchema({
			version: 1,
			collections: {
				items: {
					fields: { name: t.string() },
				},
			},
		})
		expect(extractScopeValuesFromClaims(noScopeSchema, { sub: 'user-1' })).toEqual({})
	})
})
