import { describe, expect, test } from 'vitest'
import { FULL_SCHEMA } from '../../tests/fixtures/schemas'
import { SchemaValidationError } from '../errors/errors'
import { defineSchema } from './define'
import { t } from './types'
import { validateRecord } from './validation'

const fullSchema = defineSchema(FULL_SCHEMA)
const todosCollection = fullSchema.collections.todos

function simpleTodosCollection() {
	const schema = defineSchema({
		version: 1,
		collections: {
			items: {
				fields: {
					name: t.string(),
					count: t.number(),
					active: t.boolean().default(true),
					category: t.enum(['a', 'b', 'c']).optional(),
					tags: t.array(t.string()).default([]),
					created_at: t.timestamp().auto(),
					notes: t.richtext().optional(),
				},
			},
		},
	})
	return schema.collections.items
}

describe('validateRecord', () => {
	describe('insert operations', () => {
		test('accepts valid insert data with all required fields', () => {
			if (!todosCollection) return
			const result = validateRecord(
				'todos',
				todosCollection,
				{
					title: 'Ship it',
					notes: 'Some notes',
				},
				'insert',
			)
			expect(result.title).toBe('Ship it')
			expect(result.completed).toBe(false) // default applied
			expect(result.priority).toBe('medium') // default applied
		})

		test('applies default values', () => {
			const col = simpleTodosCollection()
			if (!col) return
			const result = validateRecord('items', col, { name: 'test', count: 1 }, 'insert')
			expect(result.active).toBe(true)
			expect(result.tags).toEqual([])
		})

		test('deep-copies default array values', () => {
			const col = simpleTodosCollection()
			if (!col) return
			const r1 = validateRecord('items', col, { name: 'a', count: 1 }, 'insert')
			const r2 = validateRecord('items', col, { name: 'b', count: 2 }, 'insert')
			expect(r1.tags).not.toBe(r2.tags) // different references
		})

		test('rejects missing required fields', () => {
			if (!todosCollection) return
			expect(() => validateRecord('todos', todosCollection, { completed: true }, 'insert')).toThrow(
				SchemaValidationError,
			)
		})

		test('rejects auto fields provided by developer', () => {
			if (!todosCollection) return
			expect(() =>
				validateRecord(
					'todos',
					todosCollection,
					{
						title: 'test',
						notes: 'n',
						created_at: 123456,
					},
					'insert',
				),
			).toThrow(/auto-populated/)
		})

		test('skips auto fields in output', () => {
			if (!todosCollection) return
			const result = validateRecord(
				'todos',
				todosCollection,
				{
					title: 'test',
					notes: 'n',
				},
				'insert',
			)
			expect(result).not.toHaveProperty('created_at')
		})

		test('rejects extra fields not in schema', () => {
			if (!todosCollection) return
			expect(() =>
				validateRecord(
					'todos',
					todosCollection,
					{
						title: 'test',
						notes: 'n',
						extra_field: 'bad',
					},
					'insert',
				),
			).toThrow(SchemaValidationError)
		})
	})

	describe('update operations', () => {
		test('accepts partial updates', () => {
			if (!todosCollection) return
			const result = validateRecord('todos', todosCollection, { completed: true }, 'update')
			expect(result).toEqual({ completed: true })
		})

		test('validates types of provided fields', () => {
			if (!todosCollection) return
			expect(() =>
				validateRecord('todos', todosCollection, { completed: 'not boolean' }, 'update'),
			).toThrow(SchemaValidationError)
		})

		test('rejects extra fields', () => {
			if (!todosCollection) return
			expect(() =>
				validateRecord('todos', todosCollection, { nonexistent: 'bad' }, 'update'),
			).toThrow(SchemaValidationError)
		})
	})

	describe('delete operations', () => {
		test('returns empty object for deletes', () => {
			if (!todosCollection) return
			const result = validateRecord('todos', todosCollection, { anything: true }, 'delete')
			expect(result).toEqual({})
		})
	})

	describe('type validation', () => {
		test('rejects non-string for string field', () => {
			const col = simpleTodosCollection()
			if (!col) return
			expect(() => validateRecord('items', col, { name: 123, count: 1 }, 'insert')).toThrow(
				/must be a string/,
			)
		})

		test('rejects non-number for number field', () => {
			const col = simpleTodosCollection()
			if (!col) return
			expect(() => validateRecord('items', col, { name: 'test', count: 'abc' }, 'insert')).toThrow(
				/must be a number/,
			)
		})

		test('rejects NaN for number field', () => {
			const col = simpleTodosCollection()
			if (!col) return
			expect(() =>
				validateRecord('items', col, { name: 'test', count: Number.NaN }, 'insert'),
			).toThrow(/must be a number/)
		})

		test('rejects non-boolean for boolean field', () => {
			const col = simpleTodosCollection()
			if (!col) return
			expect(() =>
				validateRecord('items', col, { name: 'test', count: 1, active: 'yes' }, 'insert'),
			).toThrow(/must be a boolean/)
		})

		test('rejects invalid enum value', () => {
			const col = simpleTodosCollection()
			if (!col) return
			expect(() =>
				validateRecord('items', col, { name: 'test', count: 1, category: 'invalid' }, 'insert'),
			).toThrow(/must be one of/)
		})

		test('accepts valid enum value', () => {
			const col = simpleTodosCollection()
			if (!col) return
			const result = validateRecord(
				'items',
				col,
				{ name: 'test', count: 1, category: 'a' },
				'insert',
			)
			expect(result.category).toBe('a')
		})

		test('rejects non-array for array field', () => {
			const col = simpleTodosCollection()
			if (!col) return
			expect(() =>
				validateRecord('items', col, { name: 'test', count: 1, tags: 'not array' }, 'insert'),
			).toThrow(/must be an array/)
		})

		test('validates array item types', () => {
			const col = simpleTodosCollection()
			if (!col) return
			expect(() =>
				validateRecord('items', col, { name: 'test', count: 1, tags: [1, 2, 3] }, 'insert'),
			).toThrow(/must be a string/)
		})

		test('accepts valid array items', () => {
			const col = simpleTodosCollection()
			if (!col) return
			const result = validateRecord(
				'items',
				col,
				{
					name: 'test',
					count: 1,
					tags: ['a', 'b'],
				},
				'insert',
			)
			expect(result.tags).toEqual(['a', 'b'])
		})

		test('accepts string for richtext field', () => {
			const col = simpleTodosCollection()
			if (!col) return
			const result = validateRecord(
				'items',
				col,
				{
					name: 'test',
					count: 1,
					notes: 'plain text',
				},
				'insert',
			)
			expect(result.notes).toBe('plain text')
		})

		test('accepts Uint8Array for richtext field', () => {
			const col = simpleTodosCollection()
			if (!col) return
			const bytes = new Uint8Array([1, 2, 3])
			const result = validateRecord(
				'items',
				col,
				{
					name: 'test',
					count: 1,
					notes: bytes,
				},
				'insert',
			)
			expect(result.notes).toEqual(bytes)
		})

		test('rejects invalid type for richtext field', () => {
			const col = simpleTodosCollection()
			if (!col) return
			expect(() =>
				validateRecord('items', col, { name: 'test', count: 1, notes: 123 }, 'insert'),
			).toThrow(/richtext/)
		})

		test('rejects Infinity for timestamp field', () => {
			const col = simpleTodosCollection()
			if (!col) return
			// created_at is auto, so we can't set it directly. We'd need a non-auto timestamp field.
			// Test via update instead.
			const schema2 = defineSchema({
				version: 1,
				collections: {
					events: {
						fields: {
							name: t.string(),
							happened_at: t.timestamp(),
						},
					},
				},
			})
			const events = schema2.collections.events
			if (!events) return
			expect(() =>
				validateRecord(
					'events',
					events,
					{ name: 'e', happened_at: Number.POSITIVE_INFINITY },
					'insert',
				),
			).toThrow(/timestamp/)
		})
	})
})
