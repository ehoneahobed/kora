import type { Operation, RelationDefinition, SchemaDefinition } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import {
	buildMergeRelationLookup,
	checkReferentialIntegrityOnDelete,
	resolveDeleteVsInsertConflict,
} from './referential-integrity'
import type { MergeIncomingRelation, ReferentialMergeContext } from './referential-integrity'

// === Test Helpers ===

function makeOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: 'op-1',
		nodeId: 'node-a',
		type: 'delete',
		collection: 'projects',
		recordId: 'proj-1',
		data: null,
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

function makeInsertOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: 'op-2',
		nodeId: 'node-b',
		type: 'insert',
		collection: 'todos',
		recordId: 'todo-1',
		data: { title: 'New Todo', projectId: 'proj-1' },
		previousData: null,
		timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-b' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

function makeSchema(relations: Record<string, RelationDefinition> = {}): SchemaDefinition {
	return {
		version: 1,
		collections: {
			projects: {
				fields: {
					name: {
						kind: 'string',
						required: true,
						defaultValue: '',
						auto: false,
						enumValues: null,
						itemKind: null,
						mergeStrategy: null,
					},
				},
				indexes: [],
				constraints: [],
				resolvers: {},
				scope: [],
			},
			todos: {
				fields: {
					title: {
						kind: 'string',
						required: true,
						defaultValue: '',
						auto: false,
						enumValues: null,
						itemKind: null,
						mergeStrategy: null,
					},
					projectId: {
						kind: 'string',
						required: false,
						defaultValue: null,
						auto: false,
						enumValues: null,
						itemKind: null,
						mergeStrategy: null,
					},
				},
				indexes: [],
				constraints: [],
				resolvers: {},
				scope: [],
			},
			comments: {
				fields: {
					text: {
						kind: 'string',
						required: true,
						defaultValue: '',
						auto: false,
						enumValues: null,
						itemKind: null,
						mergeStrategy: null,
					},
					todoId: {
						kind: 'string',
						required: false,
						defaultValue: null,
						auto: false,
						enumValues: null,
						itemKind: null,
						mergeStrategy: null,
					},
				},
				indexes: [],
				constraints: [],
				resolvers: {},
				scope: [],
			},
		},
		relations,
		migrations: {},
	}
}

function makeCtx(records: Record<string, Record<string, unknown>[]> = {}): ReferentialMergeContext {
	return {
		async queryRecords(collection: string, where: Record<string, unknown>) {
			const collRecords = records[collection] ?? []
			return collRecords.filter((r) => {
				for (const [key, val] of Object.entries(where)) {
					if (r[key] !== val) return false
				}
				return true
			})
		},
		async recordExists(collection: string, recordId: string) {
			const collRecords = records[collection] ?? []
			return collRecords.some((r) => r.id === recordId)
		},
	}
}

// === Tests ===

describe('buildMergeRelationLookup', () => {
	test('returns empty map when no relations exist', () => {
		const schema = makeSchema({})
		const lookup = buildMergeRelationLookup(schema)

		expect(lookup.size).toBe(0)
	})

	test('maps target collection to incoming relations', () => {
		const schema = makeSchema({
			todoBelongsToProject: {
				from: 'todos',
				to: 'projects',
				type: 'many-to-one',
				field: 'projectId',
				onDelete: 'cascade',
			},
		})

		const lookup = buildMergeRelationLookup(schema)

		expect(lookup.has('projects')).toBe(true)
		const relations = lookup.get('projects')
		expect(relations).toHaveLength(1)
		expect(relations?.[0]?.relationName).toBe('todoBelongsToProject')
		expect(relations?.[0]?.sourceCollection).toBe('todos')
		expect(relations?.[0]?.foreignKeyField).toBe('projectId')
		expect(relations?.[0]?.onDelete).toBe('cascade')
	})

	test('groups multiple relations targeting the same collection', () => {
		const schema = makeSchema({
			todoBelongsToProject: {
				from: 'todos',
				to: 'projects',
				type: 'many-to-one',
				field: 'projectId',
				onDelete: 'cascade',
			},
			commentBelongsToProject: {
				from: 'comments',
				to: 'projects',
				type: 'many-to-one',
				field: 'projectId' as unknown as string,
				onDelete: 'set-null',
			},
		})

		// Need to fix the comment schema to have projectId
		schema.collections.comments = {
			...schema.collections.comments,
			fields: {
				...schema.collections.comments.fields,
				projectId: {
					kind: 'string',
					required: false,
					defaultValue: null,
					auto: false,
					enumValues: null,
					itemKind: null,
					mergeStrategy: null,
				},
			},
		}

		const lookup = buildMergeRelationLookup(schema)
		const relations = lookup.get('projects')

		expect(relations).toHaveLength(2)
		// Sorted by relation name for determinism
		expect(relations?.[0]?.relationName).toBe('commentBelongsToProject')
		expect(relations?.[1]?.relationName).toBe('todoBelongsToProject')
	})

	test('sorts relations by name for deterministic ordering', () => {
		const schema = makeSchema({
			zRelation: {
				from: 'todos',
				to: 'projects',
				type: 'many-to-one',
				field: 'projectId',
				onDelete: 'cascade',
			},
			aRelation: {
				from: 'comments',
				to: 'projects',
				type: 'many-to-one',
				field: 'projectId' as unknown as string,
				onDelete: 'restrict',
			},
		})

		schema.collections.comments = {
			...schema.collections.comments,
			fields: {
				...schema.collections.comments.fields,
				projectId: {
					kind: 'string',
					required: false,
					defaultValue: null,
					auto: false,
					enumValues: null,
					itemKind: null,
					mergeStrategy: null,
				},
			},
		}

		const lookup = buildMergeRelationLookup(schema)
		const relations = lookup.get('projects')

		expect(relations?.[0]?.relationName).toBe('aRelation')
		expect(relations?.[1]?.relationName).toBe('zRelation')
	})
})

describe('checkReferentialIntegrityOnDelete', () => {
	describe('no references', () => {
		test('allows delete when no relations target the collection', async () => {
			const schema = makeSchema({})
			const deleteOp = makeOp()
			const ctx = makeCtx()

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)

			expect(result.allowed).toBe(true)
			expect(result.sideEffectOps).toHaveLength(0)
			expect(result.traces).toHaveLength(0)
		})

		test('allows delete when no referencing records exist (cascade)', async () => {
			const schema = makeSchema({
				todoBelongsToProject: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'cascade',
				},
			})
			const deleteOp = makeOp()
			const ctx = makeCtx({ todos: [] })

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)

			expect(result.allowed).toBe(true)
			expect(result.sideEffectOps).toHaveLength(0)
			expect(result.traces).toHaveLength(1)
			expect(result.traces[0]?.strategy).toBe('referential-cascade')
		})

		test('allows delete when no referencing records exist (restrict)', async () => {
			const schema = makeSchema({
				todoBelongsToProject: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'restrict',
				},
			})
			const deleteOp = makeOp()
			const ctx = makeCtx({ todos: [] })

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)

			expect(result.allowed).toBe(true)
			expect(result.sideEffectOps).toHaveLength(0)
		})

		test('allows delete when no referencing records exist (set-null)', async () => {
			const schema = makeSchema({
				todoBelongsToProject: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'set-null',
				},
			})
			const deleteOp = makeOp()
			const ctx = makeCtx({ todos: [] })

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)

			expect(result.allowed).toBe(true)
			expect(result.sideEffectOps).toHaveLength(0)
		})

		test('allows delete when no referencing records exist (no-action)', async () => {
			const schema = makeSchema({
				todoBelongsToProject: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'no-action',
				},
			})
			const deleteOp = makeOp()
			const ctx = makeCtx({ todos: [] })

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)

			expect(result.allowed).toBe(true)
			expect(result.sideEffectOps).toHaveLength(0)
		})
	})

	describe('restrict policy', () => {
		test('blocks delete when references exist', async () => {
			const schema = makeSchema({
				todoBelongsToProject: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'restrict',
				},
			})
			const deleteOp = makeOp()
			const ctx = makeCtx({
				todos: [{ id: 'todo-1', title: 'Task 1', projectId: 'proj-1' }],
			})

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)

			expect(result.allowed).toBe(false)
			expect(result.sideEffectOps).toHaveLength(0)
			expect(result.traces).toHaveLength(1)
			expect(result.traces[0]?.strategy).toBe('referential-restrict')
		})

		test('blocks delete when multiple references exist', async () => {
			const schema = makeSchema({
				todoBelongsToProject: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'restrict',
				},
			})
			const deleteOp = makeOp()
			const ctx = makeCtx({
				todos: [
					{ id: 'todo-1', title: 'Task 1', projectId: 'proj-1' },
					{ id: 'todo-2', title: 'Task 2', projectId: 'proj-1' },
					{ id: 'todo-3', title: 'Task 3', projectId: 'proj-1' },
				],
			})

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)

			expect(result.allowed).toBe(false)
			expect(result.sideEffectOps).toHaveLength(0)
		})

		test('restrict stops processing further relations', async () => {
			// aRelation (restrict) should be processed first (alphabetical) and block immediately,
			// so zRelation (cascade) should NOT be processed.
			const schema = makeSchema({
				aRelation: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'restrict',
				},
				zRelation: {
					from: 'comments',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId' as unknown as string,
					onDelete: 'cascade',
				},
			})

			schema.collections.comments = {
				...schema.collections.comments,
				fields: {
					...schema.collections.comments.fields,
					projectId: {
						kind: 'string',
						required: false,
						defaultValue: null,
						auto: false,
						enumValues: null,
						itemKind: null,
						mergeStrategy: null,
					},
				},
			}

			const ctx = makeCtx({
				todos: [{ id: 'todo-1', title: 'Task 1', projectId: 'proj-1' }],
				comments: [{ id: 'comment-1', text: 'Hello', projectId: 'proj-1' }],
			})

			const deleteOp = makeOp()
			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)

			expect(result.allowed).toBe(false)
			// Only one trace — the restrict that blocked, not the cascade
			expect(result.traces).toHaveLength(1)
			expect(result.traces[0]?.strategy).toBe('referential-restrict')
		})
	})

	describe('cascade policy', () => {
		test('generates cascaded delete SideEffectOps for referencing records', async () => {
			const schema = makeSchema({
				todoBelongsToProject: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'cascade',
				},
			})
			const deleteOp = makeOp()
			const ctx = makeCtx({
				todos: [
					{ id: 'todo-1', title: 'Task 1', projectId: 'proj-1' },
					{ id: 'todo-2', title: 'Task 2', projectId: 'proj-1' },
				],
			})

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)

			expect(result.allowed).toBe(true)
			expect(result.sideEffectOps).toHaveLength(2)

			// Sorted by record ID
			expect(result.sideEffectOps[0]?.type).toBe('delete')
			expect(result.sideEffectOps[0]?.collection).toBe('todos')
			expect(result.sideEffectOps[0]?.recordId).toBe('todo-1')
			expect(result.sideEffectOps[0]?.data).toBeNull()
			expect(result.sideEffectOps[0]?.policy).toBe('cascade')
			expect(result.sideEffectOps[0]?.relationName).toBe('todoBelongsToProject')

			expect(result.sideEffectOps[1]?.type).toBe('delete')
			expect(result.sideEffectOps[1]?.recordId).toBe('todo-2')
		})

		test('cascade with single referencing record', async () => {
			const schema = makeSchema({
				todoBelongsToProject: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'cascade',
				},
			})
			const deleteOp = makeOp()
			const ctx = makeCtx({
				todos: [{ id: 'todo-1', title: 'Task 1', projectId: 'proj-1' }],
			})

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)

			expect(result.allowed).toBe(true)
			expect(result.sideEffectOps).toHaveLength(1)
			expect(result.sideEffectOps[0]?.type).toBe('delete')
			expect(result.sideEffectOps[0]?.recordId).toBe('todo-1')
		})
	})

	describe('set-null policy', () => {
		test('generates update SideEffectOps setting FK to null', async () => {
			const schema = makeSchema({
				todoBelongsToProject: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'set-null',
				},
			})
			const deleteOp = makeOp()
			const ctx = makeCtx({
				todos: [
					{ id: 'todo-1', title: 'Task 1', projectId: 'proj-1' },
					{ id: 'todo-2', title: 'Task 2', projectId: 'proj-1' },
				],
			})

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)

			expect(result.allowed).toBe(true)
			expect(result.sideEffectOps).toHaveLength(2)

			expect(result.sideEffectOps[0]?.type).toBe('update')
			expect(result.sideEffectOps[0]?.collection).toBe('todos')
			expect(result.sideEffectOps[0]?.recordId).toBe('todo-1')
			expect(result.sideEffectOps[0]?.data).toEqual({ projectId: null })
			expect(result.sideEffectOps[0]?.previousData).toEqual({ projectId: 'proj-1' })
			expect(result.sideEffectOps[0]?.policy).toBe('set-null')
			expect(result.sideEffectOps[0]?.relationName).toBe('todoBelongsToProject')

			expect(result.sideEffectOps[1]?.type).toBe('update')
			expect(result.sideEffectOps[1]?.recordId).toBe('todo-2')
			expect(result.sideEffectOps[1]?.data).toEqual({ projectId: null })
		})
	})

	describe('no-action policy', () => {
		test('allows delete with no side effects even when references exist', async () => {
			const schema = makeSchema({
				todoBelongsToProject: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'no-action',
				},
			})
			const deleteOp = makeOp()
			const ctx = makeCtx({
				todos: [{ id: 'todo-1', title: 'Task 1', projectId: 'proj-1' }],
			})

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)

			expect(result.allowed).toBe(true)
			expect(result.sideEffectOps).toHaveLength(0)
			expect(result.traces).toHaveLength(1)
			expect(result.traces[0]?.strategy).toBe('referential-no-action')
		})
	})

	describe('multiple relations', () => {
		test('processes all relations in deterministic sorted order', async () => {
			const schema = makeSchema({
				todoBelongsToProject: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'cascade',
				},
				commentBelongsToProject: {
					from: 'comments',
					to: 'projects',
					type: 'many-to-one',
					field: 'todoId',
					onDelete: 'set-null',
				},
			})

			// Fix comment schema for this test — FK is todoId pointing to projects
			schema.collections.comments = {
				...schema.collections.comments,
				fields: {
					...schema.collections.comments.fields,
				},
			}

			const deleteOp = makeOp()
			const ctx = makeCtx({
				todos: [{ id: 'todo-1', title: 'Task 1', projectId: 'proj-1' }],
				comments: [{ id: 'comment-1', text: 'Hello', todoId: 'proj-1' }],
			})

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)

			expect(result.allowed).toBe(true)

			// commentBelongsToProject is alphabetically first → processed first (set-null)
			// todoBelongsToProject is second → processed second (cascade)
			expect(result.sideEffectOps).toHaveLength(2)

			// First side effect from commentBelongsToProject (set-null)
			expect(result.sideEffectOps[0]?.type).toBe('update')
			expect(result.sideEffectOps[0]?.collection).toBe('comments')
			expect(result.sideEffectOps[0]?.policy).toBe('set-null')

			// Second side effect from todoBelongsToProject (cascade)
			expect(result.sideEffectOps[1]?.type).toBe('delete')
			expect(result.sideEffectOps[1]?.collection).toBe('todos')
			expect(result.sideEffectOps[1]?.policy).toBe('cascade')

			// Two traces, one per relation
			expect(result.traces).toHaveLength(2)
			expect(result.traces[0]?.strategy).toBe('referential-set-null')
			expect(result.traces[1]?.strategy).toBe('referential-cascade')
		})

		test('processes referencing records in sorted order by ID', async () => {
			const schema = makeSchema({
				todoBelongsToProject: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'cascade',
				},
			})
			const deleteOp = makeOp()
			// Records are deliberately out of order to verify sorting
			const ctx = makeCtx({
				todos: [
					{ id: 'todo-z', title: 'Z', projectId: 'proj-1' },
					{ id: 'todo-a', title: 'A', projectId: 'proj-1' },
					{ id: 'todo-m', title: 'M', projectId: 'proj-1' },
				],
			})

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)

			expect(result.sideEffectOps).toHaveLength(3)
			expect(result.sideEffectOps[0]?.recordId).toBe('todo-a')
			expect(result.sideEffectOps[1]?.recordId).toBe('todo-m')
			expect(result.sideEffectOps[2]?.recordId).toBe('todo-z')
		})
	})

	describe('pre-built relation lookup', () => {
		test('accepts a pre-built relation lookup instead of building one', async () => {
			const schema = makeSchema({})
			const deleteOp = makeOp()
			const ctx = makeCtx({
				todos: [{ id: 'todo-1', title: 'Task 1', projectId: 'proj-1' }],
			})

			// Build the lookup manually with a cascade relation
			const lookup = new Map<string, MergeIncomingRelation[]>()
			lookup.set('projects', [
				{
					relationName: 'todoBelongsToProject',
					sourceCollection: 'todos',
					foreignKeyField: 'projectId',
					onDelete: 'cascade',
				},
			])

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx, lookup)

			expect(result.allowed).toBe(true)
			expect(result.sideEffectOps).toHaveLength(1)
			expect(result.sideEffectOps[0]?.type).toBe('delete')
		})
	})

	describe('MergeTrace generation', () => {
		test('traces include tier 2 and correct constraint violated string', async () => {
			const schema = makeSchema({
				todoBelongsToProject: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'cascade',
				},
			})
			const deleteOp = makeOp()
			const ctx = makeCtx({
				todos: [{ id: 'todo-1', title: 'Task 1', projectId: 'proj-1' }],
			})

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)

			expect(result.traces).toHaveLength(1)
			const trace = result.traces[0]
			expect(trace).toBeDefined()
			if (trace === undefined) return

			expect(trace.tier).toBe(2)
			expect(trace.constraintViolated).toBe('referential:todoBelongsToProject')
			expect(trace.strategy).toBe('referential-cascade')
			expect(trace.field).toBe('todos.projectId')
			expect(typeof trace.duration).toBe('number')
			expect(trace.duration).toBeGreaterThanOrEqual(0)
		})

		test('traces include operationA as the delete operation', async () => {
			const schema = makeSchema({
				todoBelongsToProject: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'set-null',
				},
			})
			const deleteOp = makeOp({ id: 'delete-op-42' })
			const ctx = makeCtx({
				todos: [{ id: 'todo-1', title: 'Task 1', projectId: 'proj-1' }],
			})

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)
			const trace = result.traces[0]
			expect(trace).toBeDefined()
			if (trace === undefined) return

			expect(trace.operationA.id).toBe('delete-op-42')
			expect(trace.operationB.id).toBe('delete-op-42')
		})

		test('restrict trace includes referencing record IDs in inputB', async () => {
			const schema = makeSchema({
				todoBelongsToProject: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'restrict',
				},
			})
			const deleteOp = makeOp()
			const ctx = makeCtx({
				todos: [
					{ id: 'todo-1', title: 'Task 1', projectId: 'proj-1' },
					{ id: 'todo-2', title: 'Task 2', projectId: 'proj-1' },
				],
			})

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)
			const trace = result.traces[0]
			expect(trace).toBeDefined()
			if (trace === undefined) return

			expect(trace.inputB).toEqual(['todo-1', 'todo-2'])
			const output = trace.output as { allowed: boolean }
			expect(output.allowed).toBe(false)
		})

		test('cascade trace includes side effects in output', async () => {
			const schema = makeSchema({
				todoBelongsToProject: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'cascade',
				},
			})
			const deleteOp = makeOp()
			const ctx = makeCtx({
				todos: [{ id: 'todo-1', title: 'Task 1', projectId: 'proj-1' }],
			})

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)
			const trace = result.traces[0]
			expect(trace).toBeDefined()
			if (trace === undefined) return

			const output = trace.output as { allowed: boolean; sideEffects: unknown[] }
			expect(output.allowed).toBe(true)
			expect(output.sideEffects).toHaveLength(1)
		})

		test('no-references trace still generated with empty inputB', async () => {
			const schema = makeSchema({
				todoBelongsToProject: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'cascade',
				},
			})
			const deleteOp = makeOp()
			const ctx = makeCtx({ todos: [] })

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)

			expect(result.traces).toHaveLength(1)
			const trace = result.traces[0]
			expect(trace).toBeDefined()
			if (trace === undefined) return

			// When no references, inputB is null (not an array)
			expect(trace.inputB).toBeNull()
		})
	})

	describe('only processes matching references', () => {
		test('does not include records referencing a different ID', async () => {
			const schema = makeSchema({
				todoBelongsToProject: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'cascade',
				},
			})
			const deleteOp = makeOp({ recordId: 'proj-1' })
			const ctx = makeCtx({
				todos: [
					{ id: 'todo-1', title: 'Task 1', projectId: 'proj-1' },
					{ id: 'todo-2', title: 'Task 2', projectId: 'proj-2' },
					{ id: 'todo-3', title: 'Task 3', projectId: 'proj-1' },
				],
			})

			const result = await checkReferentialIntegrityOnDelete(deleteOp, schema, ctx)

			// Only the two records referencing proj-1 should be affected
			expect(result.sideEffectOps).toHaveLength(2)
			expect(result.sideEffectOps[0]?.recordId).toBe('todo-1')
			expect(result.sideEffectOps[1]?.recordId).toBe('todo-3')
		})
	})
})

describe('resolveDeleteVsInsertConflict', () => {
	const relation: MergeIncomingRelation = {
		relationName: 'todoBelongsToProject',
		sourceCollection: 'todos',
		foreignKeyField: 'projectId',
		onDelete: 'restrict',
	}

	describe('restrict policy', () => {
		test('blocks delete when insert references deleted record', () => {
			const deleteOp = makeOp()
			const insertOp = makeInsertOp()
			const restrictRelation = { ...relation, onDelete: 'restrict' as const }

			const result = resolveDeleteVsInsertConflict(deleteOp, insertOp, restrictRelation)

			expect(result.action).toBe('block-delete')
			expect(result.sideEffects).toHaveLength(0)
			expect(result.trace).not.toBeNull()
			expect(result.trace?.strategy).toBe('referential-restrict')
			expect(result.trace?.tier).toBe(2)
		})
	})

	describe('cascade policy', () => {
		test('allows delete and cascades deletion to inserted record', () => {
			const deleteOp = makeOp()
			const insertOp = makeInsertOp()
			const cascadeRelation = { ...relation, onDelete: 'cascade' as const }

			const result = resolveDeleteVsInsertConflict(deleteOp, insertOp, cascadeRelation)

			expect(result.action).toBe('allow-delete')
			expect(result.sideEffects).toHaveLength(1)
			expect(result.sideEffects[0]?.type).toBe('delete')
			expect(result.sideEffects[0]?.collection).toBe('todos')
			expect(result.sideEffects[0]?.recordId).toBe('todo-1')
			expect(result.sideEffects[0]?.policy).toBe('cascade')
			expect(result.trace?.strategy).toBe('referential-cascade')
		})
	})

	describe('set-null policy', () => {
		test('allows delete and nulls FK on inserted record', () => {
			const deleteOp = makeOp()
			const insertOp = makeInsertOp()
			const setNullRelation = { ...relation, onDelete: 'set-null' as const }

			const result = resolveDeleteVsInsertConflict(deleteOp, insertOp, setNullRelation)

			expect(result.action).toBe('allow-delete')
			expect(result.sideEffects).toHaveLength(1)
			expect(result.sideEffects[0]?.type).toBe('update')
			expect(result.sideEffects[0]?.collection).toBe('todos')
			expect(result.sideEffects[0]?.recordId).toBe('todo-1')
			expect(result.sideEffects[0]?.data).toEqual({ projectId: null })
			expect(result.sideEffects[0]?.previousData).toEqual({ projectId: 'proj-1' })
			expect(result.sideEffects[0]?.policy).toBe('set-null')
			expect(result.trace?.strategy).toBe('referential-set-null')
		})

		test('handles insert with null FK in data gracefully', () => {
			const deleteOp = makeOp()
			const insertOp = makeInsertOp({ data: { title: 'Test' } })
			const setNullRelation = { ...relation, onDelete: 'set-null' as const }

			const result = resolveDeleteVsInsertConflict(deleteOp, insertOp, setNullRelation)

			expect(result.action).toBe('allow-delete')
			expect(result.sideEffects[0]?.previousData).toEqual({ projectId: null })
		})
	})

	describe('no-action policy', () => {
		test('allows delete with no side effects', () => {
			const deleteOp = makeOp()
			const insertOp = makeInsertOp()
			const noActionRelation = { ...relation, onDelete: 'no-action' as const }

			const result = resolveDeleteVsInsertConflict(deleteOp, insertOp, noActionRelation)

			expect(result.action).toBe('allow-delete')
			expect(result.sideEffects).toHaveLength(0)
			expect(result.trace?.strategy).toBe('referential-no-action')
		})
	})

	describe('MergeTrace', () => {
		test('trace includes both delete and insert operations', () => {
			const deleteOp = makeOp({ id: 'delete-op' })
			const insertOp = makeInsertOp({ id: 'insert-op' })
			const cascadeRelation = { ...relation, onDelete: 'cascade' as const }

			const result = resolveDeleteVsInsertConflict(deleteOp, insertOp, cascadeRelation)

			expect(result.trace).not.toBeNull()
			if (result.trace === null) return

			expect(result.trace.operationA.id).toBe('delete-op')
			expect(result.trace.operationB.id).toBe('insert-op')
			expect(result.trace.tier).toBe(2)
			expect(result.trace.constraintViolated).toBe('referential:todoBelongsToProject')
			expect(result.trace.field).toBe('todos.projectId')
		})

		test('trace inputA describes delete, inputB describes insert', () => {
			const deleteOp = makeOp({ recordId: 'proj-42', collection: 'projects' })
			const insertOp = makeInsertOp({ recordId: 'todo-99', collection: 'todos' })
			const cascadeRelation = { ...relation, onDelete: 'cascade' as const }

			const result = resolveDeleteVsInsertConflict(deleteOp, insertOp, cascadeRelation)
			if (result.trace === null) return

			const inputA = result.trace.inputA as { type: string; recordId: string; collection: string }
			expect(inputA.type).toBe('delete')
			expect(inputA.recordId).toBe('proj-42')
			expect(inputA.collection).toBe('projects')

			const inputB = result.trace.inputB as { type: string; recordId: string; collection: string }
			expect(inputB.type).toBe('insert')
			expect(inputB.recordId).toBe('todo-99')
			expect(inputB.collection).toBe('todos')
		})

		test('trace output includes the action taken', () => {
			const deleteOp = makeOp()
			const insertOp = makeInsertOp()
			const restrictRelation = { ...relation, onDelete: 'restrict' as const }

			const result = resolveDeleteVsInsertConflict(deleteOp, insertOp, restrictRelation)
			if (result.trace === null) return

			const output = result.trace.output as { action: string }
			expect(output.action).toBe('block-delete')
		})

		test('trace has non-negative duration', () => {
			const deleteOp = makeOp()
			const insertOp = makeInsertOp()
			const cascadeRelation = { ...relation, onDelete: 'cascade' as const }

			const result = resolveDeleteVsInsertConflict(deleteOp, insertOp, cascadeRelation)
			if (result.trace === null) return

			expect(result.trace.duration).toBeGreaterThanOrEqual(0)
		})
	})
})
