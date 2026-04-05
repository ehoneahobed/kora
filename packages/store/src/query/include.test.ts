import { defineSchema, t } from '@kora/core'
import { describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'

/**
 * Schema with relations for testing include() queries.
 */
const RELATIONAL_SCHEMA_INPUT = {
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
				completed: t.boolean().default(false),
				project_id: t.string().optional(),
			},
		},
	},
	relations: {
		todoBelongsToProject: {
			from: 'todos' as const,
			to: 'projects' as const,
			type: 'many-to-one' as const,
			field: 'project_id',
			onDelete: 'set-null' as const,
		},
	},
}

async function createTestStore(): Promise<Store> {
	const schema = defineSchema(RELATIONAL_SCHEMA_INPUT)
	const adapter = new BetterSqlite3Adapter(':memory:')
	const store = new Store({ schema, adapter, nodeId: 'test-node' })
	await store.open()
	return store
}

describe('include() - many-to-one', () => {
	test('includes related parent record', async () => {
		const store = await createTestStore()

		const proj = await store.collection('projects').insert({ name: 'Project A' })
		await store.collection('todos').insert({ title: 'Task 1', project_id: proj.id })

		const todos = await store
			.collection('todos')
			.where({})
			.include('projects')
			.exec()

		expect(todos).toHaveLength(1)
		expect(todos[0]).toHaveProperty('project')
		expect((todos[0] as Record<string, unknown>).project).toBeTruthy()
		expect(((todos[0] as Record<string, unknown>).project as Record<string, unknown>).name).toBe('Project A')

		await store.close()
	})

	test('null FK results in null related record', async () => {
		const store = await createTestStore()

		await store.collection('todos').insert({ title: 'Task 1' })

		const todos = await store
			.collection('todos')
			.where({})
			.include('projects')
			.exec()

		expect(todos).toHaveLength(1)
		expect((todos[0] as Record<string, unknown>).project).toBeNull()

		await store.close()
	})

	test('multiple todos with same project share the reference', async () => {
		const store = await createTestStore()

		const proj = await store.collection('projects').insert({ name: 'Project A' })
		await store.collection('todos').insert({ title: 'Task 1', project_id: proj.id })
		await store.collection('todos').insert({ title: 'Task 2', project_id: proj.id })

		const todos = await store
			.collection('todos')
			.where({})
			.include('projects')
			.exec()

		expect(todos).toHaveLength(2)
		const p1 = (todos[0] as Record<string, unknown>).project as Record<string, unknown>
		const p2 = (todos[1] as Record<string, unknown>).project as Record<string, unknown>
		expect(p1.id).toBe(p2.id)
		expect(p1.name).toBe('Project A')

		await store.close()
	})
})

describe('include() - one-to-many', () => {
	test('includes related child records as array', async () => {
		const store = await createTestStore()

		const proj = await store.collection('projects').insert({ name: 'Project A' })
		await store.collection('todos').insert({ title: 'Task 1', project_id: proj.id })
		await store.collection('todos').insert({ title: 'Task 2', project_id: proj.id })

		const projects = await store
			.collection('projects')
			.where({})
			.include('todos')
			.exec()

		expect(projects).toHaveLength(1)
		const todosArr = (projects[0] as Record<string, unknown>).todos as Array<Record<string, unknown>>
		expect(todosArr).toHaveLength(2)
		expect(todosArr.map((t) => t.title).sort()).toEqual(['Task 1', 'Task 2'])

		await store.close()
	})

	test('project with no todos gets empty array', async () => {
		const store = await createTestStore()

		await store.collection('projects').insert({ name: 'Empty Project' })

		const projects = await store
			.collection('projects')
			.where({})
			.include('todos')
			.exec()

		expect(projects).toHaveLength(1)
		const todosArr = (projects[0] as Record<string, unknown>).todos as Array<Record<string, unknown>>
		expect(todosArr).toEqual([])

		await store.close()
	})
})

describe('include() - edge cases', () => {
	test('empty primary results skip batch queries', async () => {
		const store = await createTestStore()

		const todos = await store
			.collection('todos')
			.where({ title: 'nonexistent' })
			.include('projects')
			.exec()

		expect(todos).toEqual([])

		await store.close()
	})

	test('invalid include target throws QueryError', async () => {
		const store = await createTestStore()

		await store.collection('todos').insert({ title: 'Task 1' })

		await expect(
			store
				.collection('todos')
				.where({})
				.include('nonexistent')
				.exec(),
		).rejects.toThrow('No relation found')

		await store.close()
	})

	test('soft-deleted related records are excluded', async () => {
		const store = await createTestStore()

		const proj = await store.collection('projects').insert({ name: 'Project A' })
		await store.collection('todos').insert({ title: 'Task 1', project_id: proj.id })
		const task2 = await store.collection('todos').insert({ title: 'Task 2', project_id: proj.id })

		// Soft-delete task2
		await store.collection('todos').delete(task2.id)

		const projects = await store
			.collection('projects')
			.where({})
			.include('todos')
			.exec()

		expect(projects).toHaveLength(1)
		const todosArr = (projects[0] as Record<string, unknown>).todos as Array<Record<string, unknown>>
		expect(todosArr).toHaveLength(1)
		expect(todosArr[0]?.title).toBe('Task 1')

		await store.close()
	})

	test('include descriptor tracks includeCollections for subscriptions', async () => {
		const store = await createTestStore()

		const qb = store
			.collection('todos')
			.where({})
			.include('projects')

		const descriptor = qb.getDescriptor()
		expect(descriptor.include).toEqual(['projects'])

		await store.close()
	})
})
