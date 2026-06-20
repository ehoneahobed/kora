import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
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
