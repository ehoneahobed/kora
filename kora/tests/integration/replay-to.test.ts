import { defineSchema, t } from '@korajs/core'
import type { KoraEvent, Operation } from '@korajs/core'
import type { CollectionAccessor } from '@korajs/store'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

const schema = defineSchema({
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

describe('app.replayTo (time travel)', () => {
	let app: KoraApp

	afterEach(async () => {
		if (app) await app.close()
	})

	test('replays causal cut without mutating live store', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		const todos = (app as Record<string, unknown>).todos as CollectionAccessor
		const ops: Operation[] = []
		const off = app.events.on('operation:created', (event: KoraEvent) => {
			if (event.type === 'operation:created') {
				ops.push(event.operation)
			}
		})

		const record = await todos.insert({ title: 'First' })
		await todos.update(record.id, { title: 'Second' })
		off()

		const insertOp = ops.find((op) => op.type === 'insert')
		const updateOp = ops.find((op) => op.type === 'update')
		expect(insertOp).toBeDefined()
		expect(updateOp).toBeDefined()

		const atInsert = await app.replayTo(insertOp!.id)
		expect(atInsert.targetOperation.id).toBe(insertOp!.id)
		expect(atInsert.collections.todos).toHaveLength(1)
		expect((atInsert.collections.todos ?? [])[0]?.title).toBe('First')

		const atUpdate = await app.replayTo(updateOp!.id)
		expect((atUpdate.collections.todos ?? [])[0]?.title).toBe('Second')

		// Live store unchanged
		const live = await todos.findById(record.id)
		expect(live?.title).toBe('Second')
	})

	test('emits replay:completed for DevTools', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		const todos = (app as Record<string, unknown>).todos as CollectionAccessor
		let opId = ''
		const offCreated = app.events.on('operation:created', (event: KoraEvent) => {
			if (event.type === 'operation:created') {
				opId = event.operation.id
			}
		})
		await todos.insert({ title: 'Event test' })
		offCreated()

		let replayEvent: KoraEvent | null = null
		const offReplay = app.events.on('replay:completed', (event: KoraEvent) => {
			replayEvent = event
		})

		await app.replayTo(opId)
		offReplay()

		expect(replayEvent).not.toBeNull()
		expect(replayEvent).toMatchObject({
			type: 'replay:completed',
			targetOperationId: opId,
			operationsApplied: 1,
		})
	})
})
