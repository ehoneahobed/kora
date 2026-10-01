import { defineSchema, t } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { authorizeUplinkWrite } from '../scopes/server-scope-filter'
import { MemoryServerStore } from '../store/memory-server-store'
import { applyServerOperation } from './apply-server-operation'

const schema = defineSchema({
	version: 1,
	collections: {
		projects: {
			fields: {
				name: t.string(),
			},
		},
		todos: {
			fields: {
				title: t.string(),
				projectId: t.string().optional(),
			},
		},
	},
	relations: {
		todoBelongsToProject: {
			from: 'todos',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'restrict',
		},
	},
})

const cascadeSchema = defineSchema({
	version: 1,
	collections: {
		projects: {
			fields: {
				name: t.string(),
			},
		},
		todos: {
			fields: {
				title: t.string(),
				projectId: t.string().optional(),
			},
		},
	},
	relations: {
		todoBelongsToProject: {
			from: 'todos',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'cascade',
		},
	},
})

function makeOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: `op-${Math.random().toString(36).slice(2)}`,
		nodeId: 'client-1',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'test' },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'client-1' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe('applyServerOperation', () => {
	test('rejects delete when restrict policy is violated', async () => {
		const store = new MemoryServerStore('server-test')
		await store.setSchema(schema)

		await store.applyRemoteOperation(
			makeOp({
				id: 'op-project',
				collection: 'projects',
				recordId: 'proj-1',
				data: { name: 'Kora' },
			}),
		)
		await store.applyRemoteOperation(
			makeOp({
				id: 'op-todo',
				collection: 'todos',
				recordId: 'todo-1',
				data: { title: 'Ship', projectId: 'proj-1' },
			}),
		)

		const deleteProject = makeOp({
			id: 'op-delete-project',
			type: 'delete',
			collection: 'projects',
			recordId: 'proj-1',
			data: null,
			sequenceNumber: 3,
		})

		const result = await applyServerOperation(store, deleteProject)
		expect(result.rejection?.code).toBe('REFERENTIAL_INTEGRITY')
		expect(await store.findRecord('projects', 'proj-1')).not.toBeNull()

		await store.close()
	})

	test('cascade delete generates server side-effect operations', async () => {
		const store = new MemoryServerStore('server-test')
		await store.setSchema(cascadeSchema)

		await store.applyRemoteOperation(
			makeOp({
				id: 'op-project',
				collection: 'projects',
				recordId: 'proj-1',
				data: { name: 'Kora' },
			}),
		)
		await store.applyRemoteOperation(
			makeOp({
				id: 'op-todo',
				collection: 'todos',
				recordId: 'todo-1',
				data: { title: 'Ship', projectId: 'proj-1' },
			}),
		)

		const deleteProject = makeOp({
			id: 'op-delete-project',
			type: 'delete',
			collection: 'projects',
			recordId: 'proj-1',
			data: null,
			sequenceNumber: 3,
		})

		const result = await applyServerOperation(store, deleteProject)
		expect(result.result).toBe('applied')
		expect(result.appliedOperations.length).toBeGreaterThan(1)
		expect(await store.findRecord('todos', 'todo-1')).toBeNull()
		expect(await store.getOperationCount()).toBe(4)

		await store.close()
	})
})

describe('untrusted deletes: side effects authorized, restrict generic (RT-10)', () => {
	async function seeded(target: SchemaDefinition, owner: string) {
		const store = new MemoryServerStore('server-test')
		await store.setSchema(target)
		await store.applyRemoteOperation(
			makeOp({ id: 'p', collection: 'projects', recordId: 'proj-1', data: { name: 'mine' } }),
		)
		await store.applyRemoteOperation(
			makeOp({
				id: 't',
				collection: 'todos',
				recordId: 'todo-of-other',
				data: { title: owner, projectId: 'proj-1' },
				sequenceNumber: 2,
			}),
		)
		return store
	}
	const del = () =>
		makeOp({
			id: 'del',
			type: 'delete',
			collection: 'projects',
			recordId: 'proj-1',
			data: null,
			sequenceNumber: 3,
		})
	// The writer may touch projects freely but only its own todos (title === 'me').
	const scopes = { projects: {}, todos: { title: 'me' } }

	test('a cascade into a record outside the writer scope refuses the whole delete', async () => {
		const store = await seeded(cascadeSchema, 'someone-else')
		const op = del()
		const result = await applyServerOperation(store, op, undefined, {
			authorize: (stored) => authorizeUplinkWrite(op, stored, scopes),
			authorizeSideEffect: (effect, stored) => authorizeUplinkWrite(effect, stored, scopes),
		})
		expect(result.rejection?.code).toBe('RESTRICTED')
		expect(result.rejection?.message).not.toContain('todo-of-other')
		expect(await store.findRecord('projects', 'proj-1')).not.toBeNull()
		expect(await store.findRecord('todos', 'todo-of-other')).not.toBeNull()
		await store.close()
	})

	test('a cascade inside the writer scope still applies', async () => {
		const store = await seeded(cascadeSchema, 'me')
		const op = del()
		const result = await applyServerOperation(store, op, undefined, {
			authorize: (stored) => authorizeUplinkWrite(op, stored, scopes),
			authorizeSideEffect: (effect, stored) => authorizeUplinkWrite(effect, stored, scopes),
		})
		expect(result.result).toBe('applied')
		expect(result.appliedOperations).toHaveLength(2)
		await store.close()
	})

	test('an untrusted restrict refusal is the generic RESTRICTED (no ids or counts)', async () => {
		const store = await seeded(schema, 'someone-else')
		const op = del()
		const result = await applyServerOperation(store, op, undefined, {
			authorize: (stored) => authorizeUplinkWrite(op, stored, scopes),
		})
		expect(result.rejection).toEqual({
			code: 'RESTRICTED',
			message: expect.not.stringContaining('todo-of-other'),
			retriable: false,
		})
		await store.close()
	})

	test('a trusted (server) delete keeps the REFERENTIAL_INTEGRITY code', async () => {
		const store = await seeded(schema, 'someone-else')
		const result = await applyServerOperation(store, del())
		expect(result.rejection?.code).toBe('REFERENTIAL_INTEGRITY')
		await store.close()
	})
})
