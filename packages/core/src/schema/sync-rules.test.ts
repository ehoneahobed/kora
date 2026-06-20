import { describe, expect, test } from 'vitest'
import { SchemaValidationError } from '../errors/errors'
import { defineSchema, t } from '../index'

describe('defineSchema sync rules DSL', () => {
	test('accepts declarative sync rules and derives collection scope fields', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				todos: {
					fields: {
						title: t.string(),
						userId: t.string(),
					},
				},
			},
			sync: {
				todos: { where: { userId: true } },
			},
		})

		expect(schema.sync).toEqual({ todos: { where: { userId: 'userId' } } })
		expect(schema.collections.todos?.scope).toEqual(['userId'])
	})

	test('rejects sync rules for unknown collections', () => {
		expect(() =>
			defineSchema({
				version: 1,
				collections: {
					todos: {
						fields: { title: t.string() },
					},
				},
				sync: {
					missing: { where: { title: true } },
				},
			}),
		).toThrow(SchemaValidationError)
	})

	test('rejects sync rules referencing unknown fields', () => {
		expect(() =>
			defineSchema({
				version: 1,
				collections: {
					todos: {
						fields: { title: t.string() },
					},
				},
				sync: {
					todos: { where: { userId: true } },
				},
			}),
		).toThrow(SchemaValidationError)
	})

	test('rejects empty where bindings', () => {
		expect(() =>
			defineSchema({
				version: 1,
				collections: {
					todos: {
						fields: { title: t.string(), userId: t.string() },
					},
				},
				sync: {
					todos: { where: {} },
				},
			}),
		).toThrow(SchemaValidationError)
	})
})
