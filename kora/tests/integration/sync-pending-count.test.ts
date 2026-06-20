import { defineSchema, t } from '@korajs/core'
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
			},
		},
	},
})

describe('Sync pending count from op log', () => {
	let app: KoraApp

	afterEach(async () => {
		if (app) await app.close()
	})

	test('getPendingSyncOperations reflects local ops before connect', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: { url: 'wss://localhost:9999' },
		})
		await app.ready

		const todos = (app as Record<string, unknown>).todos as CollectionAccessor
		await todos.insert({ title: 'Offline op' })
		await todos.insert({ title: 'Second op' })

		const syncEngine = app.getSyncEngine()
		expect(syncEngine).not.toBeNull()

		const pending = await syncEngine?.getPendingSyncOperations()
		expect(pending?.length).toBe(2)

		const status = syncEngine?.getStatus()
		expect(status?.pendingOperations).toBe(2)

		const unsyncedCount = await syncEngine?.getUnsyncedOperationCount()
		expect(unsyncedCount).toBe(2)
	})
})
