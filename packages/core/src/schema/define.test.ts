import { describe, expect, test } from 'vitest'
import { SchemaValidationError } from '../errors/errors'
import { FULL_SCHEMA, MINIMAL_SCHEMA } from '../../tests/fixtures/schemas'
import { defineSchema } from './define'
import { t } from './types'

describe('defineSchema', () => {
	test('builds a minimal schema', () => {
		const schema = defineSchema(MINIMAL_SCHEMA)
		expect(schema.version).toBe(1)
		expect(Object.keys(schema.collections)).toEqual(['todos'])

		const todos = schema.collections.todos
		expect(todos).toBeDefined()
		expect(todos?.fields.title?.kind).toBe('string')
		expect(todos?.fields.title?.required).toBe(true)
	})

	test('builds a full-featured schema', () => {
		const schema = defineSchema(FULL_SCHEMA)
		expect(schema.version).toBe(2)
		expect(Object.keys(schema.collections)).toEqual(['todos', 'projects'])

		const todos = schema.collections.todos
		expect(todos?.fields.completed?.defaultValue).toBe(false)
		expect(todos?.fields.tags?.kind).toBe('array')
		expect(todos?.fields.tags?.itemKind).toBe('string')
		expect(todos?.fields.priority?.enumValues).toEqual(['low', 'medium', 'high'])
		expect(todos?.fields.created_at?.auto).toBe(true)
		expect(todos?.indexes).toEqual(['assignee', 'completed', 'due_date'])
		expect(todos?.constraints).toHaveLength(1)
		expect(Object.keys(todos?.resolvers ?? {})).toEqual(['tags'])

		expect(Object.keys(schema.relations)).toEqual(['todo_belongs_to_project'])
		expect(schema.relations.todo_belongs_to_project?.from).toBe('todos')
		expect(schema.relations.todo_belongs_to_project?.to).toBe('projects')
	})

	describe('version validation', () => {
		test('rejects version 0', () => {
			expect(() => defineSchema({ ...MINIMAL_SCHEMA, version: 0 })).toThrow(
				SchemaValidationError,
			)
		})

		test('rejects negative version', () => {
			expect(() => defineSchema({ ...MINIMAL_SCHEMA, version: -1 })).toThrow(
				SchemaValidationError,
			)
		})

		test('rejects non-integer version', () => {
			expect(() => defineSchema({ ...MINIMAL_SCHEMA, version: 1.5 })).toThrow(
				SchemaValidationError,
			)
		})
	})

	describe('collection name validation', () => {
		test('rejects uppercase collection names', () => {
			expect(() =>
				defineSchema({
					version: 1,
					collections: { MyCollection: { fields: { name: t.string() } } },
				}),
			).toThrow(SchemaValidationError)
		})

		test('rejects names starting with numbers', () => {
			expect(() =>
				defineSchema({
					version: 1,
					collections: { '1todos': { fields: { name: t.string() } } },
				}),
			).toThrow(SchemaValidationError)
		})

		test('rejects names with hyphens', () => {
			expect(() =>
				defineSchema({
					version: 1,
					collections: { 'my-collection': { fields: { name: t.string() } } },
				}),
			).toThrow(SchemaValidationError)
		})

		test('accepts names with underscores', () => {
			const schema = defineSchema({
				version: 1,
				collections: { my_collection: { fields: { name: t.string() } } },
			})
			expect(schema.collections.my_collection).toBeDefined()
		})
	})

	describe('field name validation', () => {
		test('rejects reserved field name "id"', () => {
			expect(() =>
				defineSchema({
					version: 1,
					collections: { todos: { fields: { id: t.string() } } },
				}),
			).toThrow(SchemaValidationError)
		})

		test('rejects invalid field names', () => {
			expect(() =>
				defineSchema({
					version: 1,
					collections: { todos: { fields: { 'my-field': t.string() } } },
				}),
			).toThrow(SchemaValidationError)
		})
	})

	describe('index validation', () => {
		test('rejects index on non-existent field', () => {
			expect(() =>
				defineSchema({
					version: 1,
					collections: {
						todos: {
							fields: { title: t.string() },
							indexes: ['nonexistent'],
						},
					},
				}),
			).toThrow(SchemaValidationError)
		})
	})

	describe('constraint validation', () => {
		test('rejects constraint on non-existent field', () => {
			expect(() =>
				defineSchema({
					version: 1,
					collections: {
						todos: {
							fields: { title: t.string() },
							constraints: [
								{
									type: 'unique',
									fields: ['nonexistent'],
									onConflict: 'last-write-wins',
								},
							],
						},
					},
				}),
			).toThrow(SchemaValidationError)
		})

		test('rejects priority-field strategy without priorityField', () => {
			expect(() =>
				defineSchema({
					version: 1,
					collections: {
						todos: {
							fields: { title: t.string() },
							constraints: [
								{
									type: 'unique',
									fields: ['title'],
									onConflict: 'priority-field',
								},
							],
						},
					},
				}),
			).toThrow(SchemaValidationError)
		})

		test('rejects custom strategy without resolve function', () => {
			expect(() =>
				defineSchema({
					version: 1,
					collections: {
						todos: {
							fields: { title: t.string() },
							constraints: [
								{
									type: 'unique',
									fields: ['title'],
									onConflict: 'custom',
								},
							],
						},
					},
				}),
			).toThrow(SchemaValidationError)
		})
	})

	describe('resolver validation', () => {
		test('rejects resolver for non-existent field', () => {
			expect(() =>
				defineSchema({
					version: 1,
					collections: {
						todos: {
							fields: { title: t.string() },
							resolve: {
								nonexistent: () => 'value',
							},
						},
					},
				}),
			).toThrow(SchemaValidationError)
		})
	})

	describe('relation validation', () => {
		test('rejects relation with non-existent source collection', () => {
			expect(() =>
				defineSchema({
					version: 1,
					collections: {
						todos: { fields: { project_id: t.string() } },
					},
					relations: {
						rel: {
							from: 'nonexistent',
							to: 'todos',
							type: 'many-to-one',
							field: 'project_id',
							onDelete: 'set-null',
						},
					},
				}),
			).toThrow(SchemaValidationError)
		})

		test('rejects relation with non-existent target collection', () => {
			expect(() =>
				defineSchema({
					version: 1,
					collections: {
						todos: { fields: { project_id: t.string() } },
					},
					relations: {
						rel: {
							from: 'todos',
							to: 'nonexistent',
							type: 'many-to-one',
							field: 'project_id',
							onDelete: 'set-null',
						},
					},
				}),
			).toThrow(SchemaValidationError)
		})

		test('rejects relation with non-existent field', () => {
			expect(() =>
				defineSchema({
					version: 1,
					collections: {
						todos: { fields: { title: t.string() } },
						projects: { fields: { name: t.string() } },
					},
					relations: {
						rel: {
							from: 'todos',
							to: 'projects',
							type: 'many-to-one',
							field: 'nonexistent',
							onDelete: 'set-null',
						},
					},
				}),
			).toThrow(SchemaValidationError)
		})
	})

	test('rejects empty collections', () => {
		expect(() =>
			defineSchema({
				version: 1,
				collections: {},
			}),
		).toThrow(SchemaValidationError)
	})

	test('rejects collection with no fields', () => {
		expect(() =>
			defineSchema({
				version: 1,
				collections: {
					todos: { fields: {} },
				},
			}),
		).toThrow(SchemaValidationError)
	})
})
