import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { createTestNetwork, expectConverged, expectConvergedEventually } from '@korajs/test'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'

const todosSchema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
			},
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
				projectId: t.string(),
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

/**
 * PRODUCTION_PATH: Store + MergeAwareSyncStore + SyncEngine + SQLite (via @korajs/test).
 */
describe('PRODUCTION_PATH sync convergence', () => {
	test('sequential local inserts record causal dependencies in op log', async () => {
		const network = await createTestNetwork(todosSchema, { devices: 1 })
		try {
			const device = network.devices[0]
			if (!device) {
				return
			}
			await device.collection('todos').insert({ title: 'First' })
			await device.collection('todos').insert({ title: 'Second' })

			const nodeId = device.getNodeId()
			const seq = device.getVersionVector().get(nodeId) ?? 0
			const ops = await device.store.getOperationRange(nodeId, 1, seq)
			expect(ops).toHaveLength(2)
			expect(ops[0]?.causalDeps).toEqual([])
			expect(ops[1]?.causalDeps).toContain(ops[0]?.id)
		} finally {
			await network.close()
		}
	})

	test('cascade delete side effects depend on parent delete op', async () => {
		const network = await createTestNetwork(cascadeSchema, { devices: 1 })
		try {
			const device = network.devices[0]
			if (!device) {
				return
			}
			const project = await device.collection('projects').insert({ name: 'Cascade' })
			await device.collection('todos').insert({ title: 'Child', projectId: project.id })
			await device.collection('projects').delete(project.id)

			const nodeId = device.getNodeId()
			const seq = device.getVersionVector().get(nodeId) ?? 0
			const ops = await device.store.getOperationRange(nodeId, 1, seq)
			const projectDelete = ops.find(
				(op: Operation) => op.collection === 'projects' && op.type === 'delete',
			)
			const todoDelete = ops.find(
				(op: Operation) => op.collection === 'todos' && op.type === 'delete',
			)
			expect(projectDelete).toBeDefined()
			expect(todoDelete).toBeDefined()
			expect(todoDelete?.causalDeps).toContain(projectDelete?.id)
		} finally {
			await network.close()
		}
	})

	test('offline insert on A syncs to B', async () => {
		const network = await createTestNetwork(todosSchema, { devices: 2 })
		try {
			const deviceA = network.devices[0]
			const deviceB = network.devices[1]
			if (!deviceA || !deviceB) {
				throw new Error('expected two devices')
			}
			await deviceA.collection('todos').insert({ title: 'Production path' })
			await deviceA.sync()
			await deviceB.sync()
			await expectConverged(network.devices, todosSchema)
		} finally {
			await network.close()
		}
	})

	test('delete vs update: newer local update wins over remote delete on peer', async () => {
		const network = await createTestNetwork(todosSchema, { devices: 2 })
		try {
			const deviceA = network.devices[0]
			const deviceB = network.devices[1]
			if (!deviceA || !deviceB) {
				throw new Error('expected two devices')
			}
			const todo = await deviceA.collection('todos').insert({ title: 'Original' })
			await deviceA.sync()
			await deviceB.sync()

			// Delete on A before sync, then B updates so its op is strictly later than the delete
			await deviceA.collection('todos').delete(todo.id)
			await deviceB.collection('todos').update(todo.id, { title: 'Kept by B' })

			await deviceA.sync()
			await deviceB.sync()

			const todosOnB = await deviceB.getState('todos')
			expect(todosOnB).toHaveLength(1)
			expect(todosOnB[0]?.title).toBe('Kept by B')
		} finally {
			await network.close()
		}
	})

	test('remote cascade delete removes dependent records on peer', async () => {
		const network = await createTestNetwork(cascadeSchema, { devices: 2 })
		try {
			const deviceA = network.devices[0]
			const deviceB = network.devices[1]
			if (!deviceA || !deviceB) {
				throw new Error('expected two devices')
			}

			const project = await deviceA.collection('projects').insert({ name: 'P1' })
			await deviceA.collection('todos').insert({
				title: 'T1',
				projectId: project.id,
			})
			await deviceA.sync()
			await deviceB.sync()

			await deviceA.collection('projects').delete(project.id)
			await deviceA.sync()
			await deviceB.sync()
			await expectConvergedEventually([deviceA, deviceB], cascadeSchema)

			const todosOnB = await deviceB.getState('todos')
			const projectsOnB = await deviceB.getState('projects')
			expect(todosOnB).toHaveLength(0)
			expect(projectsOnB).toHaveLength(0)
		} finally {
			await network.close()
		}
	})
})

describe('PRODUCTION_PATH operation log compaction', () => {
	test('compact after sync preserves convergence on reconnect', async () => {
		const network = await createTestNetwork(todosSchema, { devices: 2 })
		try {
			const deviceA = network.devices[0]
			const deviceB = network.devices[1]
			if (!deviceA || !deviceB) {
				throw new Error('expected two devices')
			}
			await deviceA.collection('todos').insert({ title: 'Compact me' })
			await deviceA.sync()
			await deviceB.sync()

			const serverVector = await deviceA.store.loadLastAckedServerVector()
			const compacted = await deviceA.store.compact({ mode: 'after-ack', serverVector })
			expect(compacted.deletedCount).toBeGreaterThan(0)

			await deviceA.collection('todos').insert({ title: 'After compact' })
			await deviceA.sync()
			await deviceB.sync()
			await expectConverged(network.devices, todosSchema)
		} finally {
			await network.close()
		}
	})
})

describe('PRODUCTION_PATH createApp', () => {
	test('createApp with sync uses merge-aware store', async () => {
		const app = createApp({
			schema: todosSchema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: { url: 'wss://localhost:9999' },
		})
		await app.ready

		const todos = (app as Record<string, unknown>).todos as {
			insert: (data: Record<string, unknown>) => Promise<{ id: string }>
		}
		await todos.insert({ title: 'Queued' })
		expect(app.getSyncEngine()?.getOutboundQueue().totalPending).toBeGreaterThanOrEqual(1)
		await app.close()
	})
})
