/**
 * Phase 3 seam 5: a device that applies a REMOTE delete cascades locally (so its view
 * is consistent offline), while the server derives its own `server/` cascade. Both
 * copies must be idempotent in effect: the outcome may not depend on WHEN a third
 * device happened to apply the delete.
 *
 * The server's copy is stamped right after the parent delete, so a concurrent write
 * to the child that is later than the delete (re-pointing it, editing it) still wins.
 * A device's copy is stamped the same way; stamped with the device's "now" instead,
 * it would beat that later write on every replica (converging, but erasing an edit
 * the server alone would keep).
 *
 * Three devices: A deletes the parent; C, offline, writes the child after the delete;
 * B applies the delete only after C's write (so B's cascade runs later in real time).
 */
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { type TestDevice, createTestNetwork } from '../src/index'

function relationSchema(onDelete: 'cascade' | 'set-null'): SchemaDefinition {
	return defineSchema({
		version: 1,
		collections: {
			projects: { fields: { name: t.string() } },
			todos: { fields: { title: t.string(), projectId: t.string().optional() } },
		},
		relations: {
			todoProject: {
				from: 'todos',
				to: 'projects',
				type: 'many-to-one',
				field: 'projectId',
				onDelete,
			},
		},
	}) as unknown as SchemaDefinition
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function syncAll(devices: TestDevice[], passes = 3): Promise<void> {
	for (let pass = 0; pass < passes; pass++) for (const device of devices) await device.sync()
}

describe('client cascades of a remote delete converge with the server copy (3 devices)', () => {
	test('cascade: delete vs a later update of the child — the later update wins everywhere', async () => {
		const network = await createTestNetwork(relationSchema('cascade'), { devices: 3 })
		try {
			const [a, b, c] = network.devices as [TestDevice, TestDevice, TestDevice]
			const project = await a.collection('projects').insert({ name: 'P' })
			const todo = await a
				.collection('todos')
				.insert({ title: 'child', projectId: String(project.id) })
			await syncAll([a, b, c], 1)
			await b.disconnect()
			await c.disconnect()

			await a.collection('projects').delete(String(project.id))
			await a.sync()
			await pause(5)
			// C, offline, edits the child AFTER the delete.
			await c.collection('todos').update(String(todo.id), { title: 'edited after the delete' })
			await pause(5)
			// B applies the delete only now, and cascades locally.
			await b.sync()
			await syncAll([c, a, b])

			const views = [
				await network.server.store.findRecord('todos', String(todo.id)),
				await a.collection('todos').findById(String(todo.id)),
				await b.collection('todos').findById(String(todo.id)),
				await c.collection('todos').findById(String(todo.id)),
			]
			for (const view of views) {
				expect(view).toMatchObject({ title: 'edited after the delete' })
			}
			for (const device of [a, b, c]) expect(await device.getRejectedOperations()).toEqual([])
		} finally {
			await network.close()
		}
	}, 60_000)

	test('set-null: delete vs a later re-point of the child — the re-point wins everywhere', async () => {
		const network = await createTestNetwork(relationSchema('set-null'), { devices: 3 })
		try {
			const [a, b, c] = network.devices as [TestDevice, TestDevice, TestDevice]
			const p = await a.collection('projects').insert({ name: 'P' })
			const q = await a.collection('projects').insert({ name: 'Q' })
			const todo = await a.collection('todos').insert({ title: 'child', projectId: String(p.id) })
			await syncAll([a, b, c], 1)
			await b.disconnect()
			await c.disconnect()

			await a.collection('projects').delete(String(p.id))
			await a.sync()
			await pause(5)
			await c.collection('todos').update(String(todo.id), { projectId: String(q.id) })
			await pause(5)
			await b.sync()
			await syncAll([c, a, b])

			const views = [
				await network.server.store.findRecord('todos', String(todo.id)),
				await a.collection('todos').findById(String(todo.id)),
				await b.collection('todos').findById(String(todo.id)),
				await c.collection('todos').findById(String(todo.id)),
			]
			for (const view of views) expect(view).toMatchObject({ projectId: String(q.id) })
		} finally {
			await network.close()
		}
	}, 60_000)

	test('without a concurrent write, every copy deletes / nulls once in effect', async () => {
		const network = await createTestNetwork(relationSchema('set-null'), { devices: 3 })
		try {
			const [a, b, c] = network.devices as [TestDevice, TestDevice, TestDevice]
			const p = await a.collection('projects').insert({ name: 'P' })
			const todo = await a.collection('todos').insert({ title: 'child', projectId: String(p.id) })
			await syncAll([a, b, c], 1)
			await b.collection('projects').delete(String(p.id))
			await syncAll([b, a, c])
			for (const view of [
				await network.server.store.findRecord('todos', String(todo.id)),
				await a.collection('todos').findById(String(todo.id)),
				await b.collection('todos').findById(String(todo.id)),
				await c.collection('todos').findById(String(todo.id)),
			]) {
				expect(view).toMatchObject({ title: 'child', projectId: null })
			}
		} finally {
			await network.close()
		}
	}, 60_000)
})
