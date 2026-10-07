import { describe, expect, test } from 'vitest'
import { FULL_SCHEMA, MINIMAL_SCHEMA } from '../../tests/fixtures/schemas'
import { SchemaValidationError } from '../errors/errors'
import { migrate } from '../migrations/migration-builder'
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
			expect(() => defineSchema({ ...MINIMAL_SCHEMA, version: 0 })).toThrow(SchemaValidationError)
		})

		test('rejects negative version', () => {
			expect(() => defineSchema({ ...MINIMAL_SCHEMA, version: -1 })).toThrow(SchemaValidationError)
		})

		test('rejects non-integer version', () => {
			expect(() => defineSchema({ ...MINIMAL_SCHEMA, version: 1.5 })).toThrow(SchemaValidationError)
		})
	})

	describe('collection name validation', () => {
		test('accepts PascalCase collection names (generated SQL is quoted)', () => {
			const schema = defineSchema({
				version: 1,
				collections: { MyCollection: { fields: { name: t.string() } } },
			})
			expect(schema.collections.MyCollection).toBeDefined()
		})

		test('accepts camelCase collection names', () => {
			const schema = defineSchema({
				version: 1,
				collections: { formResponses: { fields: { name: t.string() } } },
			})
			expect(schema.collections.formResponses).toBeDefined()
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
		const withWhere = (
			where: Record<string, unknown>,
			type: 'unique' | 'capacity' | 'referential' = 'unique',
		) =>
			defineSchema({
				version: 1,
				collections: {
					docs: {
						fields: { slug: t.string(), status: t.string(), parentId: t.string().optional() },
						constraints: [
							{
								type,
								fields: [type === 'referential' ? 'parentId' : 'slug'],
								where,
								onConflict: 'first-write-wins',
							},
						],
					},
				},
			})

		test('rejects operator objects in a constraint where (F2)', () => {
			expect(() => withWhere({ status: { $ne: 'draft' } })).toThrow(/plain equality/)
			expect(() => withWhere({ status: { $in: ['a', 'b'] } })).toThrow(SchemaValidationError)
			expect(() => withWhere({ status: ['a', 'b'] }, 'capacity')).toThrow(/an array/)
		})

		test('rejects a constraint where on a field that does not exist (F2)', () => {
			expect(() => withWhere({ state: 'published' })).toThrow(/does not exist/)
		})

		test('accepts equality values in a constraint where, and referential metadata', () => {
			expect(() => withWhere({ status: 'published' })).not.toThrow()
			expect(() => withWhere({ status: null, id: 'x' })).not.toThrow()
			expect(() => withWhere({ collection: 'docs' }, 'referential')).not.toThrow()
		})

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

	describe('migration validation', () => {
		test('accepts valid migrations', () => {
			const schema = defineSchema({
				version: 2,
				collections: {
					products: {
						fields: {
							name: t.string(),
							taxInclusive: t.boolean().default(false),
						},
					},
				},
				migrations: {
					2: migrate().addField('products', 'taxInclusive', t.boolean().default(false)),
				},
			})
			expect(schema.migrations[2]).toBeDefined()
			expect(schema.migrations[2]?.steps).toHaveLength(1)
		})

		test('defaults migrations to empty object when not specified', () => {
			const schema = defineSchema({
				version: 1,
				collections: {
					todos: { fields: { title: t.string() } },
				},
			})
			expect(schema.migrations).toEqual({})
		})

		test('rejects migration with version < 2', () => {
			expect(() =>
				defineSchema({
					version: 1,
					collections: {
						todos: { fields: { title: t.string() } },
					},
					migrations: {
						1: migrate().addField('todos', 'extra', t.string()),
					},
				}),
			).toThrow(SchemaValidationError)
		})

		test('rejects migration with version > schema version', () => {
			expect(() =>
				defineSchema({
					version: 2,
					collections: {
						todos: { fields: { title: t.string() } },
					},
					migrations: {
						3: migrate().addField('todos', 'extra', t.string()),
					},
				}),
			).toThrow(SchemaValidationError)
		})

		test('rejects migration with no steps', () => {
			expect(() =>
				defineSchema({
					version: 2,
					collections: {
						todos: { fields: { title: t.string() } },
					},
					migrations: {
						2: migrate(),
					},
				}),
			).toThrow(SchemaValidationError)
		})

		test('accepts multiple migrations for different versions', () => {
			const schema = defineSchema({
				version: 3,
				collections: {
					products: {
						fields: {
							name: t.string(),
							taxInclusive: t.boolean().default(false),
							category: t.string().optional(),
						},
					},
				},
				migrations: {
					2: migrate().addField('products', 'taxInclusive', t.boolean().default(false)),
					3: migrate().addField('products', 'category', t.string().optional()),
				},
			})
			expect(Object.keys(schema.migrations)).toEqual(['2', '3'])
		})
	})

	describe('scope validation', () => {
		test('accepts valid scope fields', () => {
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
				},
			})
			expect(schema.collections.sales!.scope).toEqual(['orgId', 'storeId'])
		})

		test('defaults scope to empty array when not specified', () => {
			const schema = defineSchema({
				version: 1,
				collections: {
					todos: { fields: { title: t.string() } },
				},
			})
			expect(schema.collections.todos!.scope).toEqual([])
		})

		test('rejects scope with non-existent field', () => {
			expect(() =>
				defineSchema({
					version: 1,
					collections: {
						sales: {
							fields: { total: t.number() },
							scope: ['nonexistent'],
						},
					},
				}),
			).toThrow(SchemaValidationError)
		})
	})

	describe('field-level transitions (NEW-STORE-3)', () => {
		const status = () =>
			t
				.enum(['draft', 'submitted', 'delivered'])
				.default('draft')
				.transitions({ draft: ['submitted'], submitted: ['delivered'], delivered: [] })

		test('derive the collection state machine with the default reject mode', () => {
			const schema = defineSchema({
				version: 1,
				collections: { orders: { fields: { status: status() } } },
			})
			expect(schema.collections.orders?.stateMachine).toEqual({
				field: 'status',
				transitions: { draft: ['submitted'], submitted: ['delivered'], delivered: [] },
				onInvalidTransition: 'reject',
			})
		})

		test('a collection-level state machine on the same field wins', () => {
			const schema = defineSchema({
				version: 1,
				collections: {
					orders: {
						fields: { status: status() },
						stateMachine: {
							field: 'status',
							transitions: { draft: ['submitted', 'delivered'] },
							onInvalidTransition: 'last-valid-state',
						},
					},
				},
			})
			expect(schema.collections.orders?.stateMachine?.onInvalidTransition).toBe('last-valid-state')
			expect(schema.collections.orders?.stateMachine?.transitions.draft).toEqual([
				'submitted',
				'delivered',
			])
		})

		test('several transition fields keep their own maps and derive no single machine', () => {
			const schema = defineSchema({
				version: 1,
				collections: {
					orders: {
						fields: {
							status: status(),
							payment: t.enum(['open', 'paid']).transitions({ open: ['paid'], paid: [] }),
						},
					},
				},
			})
			expect(schema.collections.orders?.stateMachine).toBeUndefined()
			expect(schema.collections.orders?.fields.payment?.transitions).toEqual({
				open: ['paid'],
				paid: [],
			})
		})
	})
})
