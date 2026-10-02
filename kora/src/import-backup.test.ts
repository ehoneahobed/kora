import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from './create-app'
import type { KoraApp } from './types'

/** STORE-5: app.importBackup keeps the device's identity and unsynced writes. */
const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

type Todos = { insert(data: { title: string }): Promise<{ id: string }> }
const todos = (app: KoraApp): Todos => (app as unknown as { todos: Todos }).todos
const titles = async (app: KoraApp): Promise<string[]> =>
	(await app.getStore().collection('todos').where({}).exec()).map((r) => String(r.title)).sort()

describe('app.importBackup', () => {
	const apps: KoraApp[] = []
	afterEach(async () => {
		for (const app of apps.splice(0)) await app.close()
	})

	const local = async (): Promise<KoraApp> => {
		const app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		apps.push(app)
		await app.ready
		return app
	}
	const synced = async (): Promise<KoraApp> => {
		const app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: { url: 'ws://127.0.0.1:9', autoReconnect: false },
		})
		apps.push(app)
		await app.ready
		return app
	}

	test('a local-only app gets an exact replace by default', async () => {
		const source = await local()
		await todos(source).insert({ title: 'from-backup' })
		const target = await local()
		await todos(target).insert({ title: 'replaced' })
		const result = await target.importBackup(await source.exportBackup())
		expect(result).toMatchObject({ success: true, unsyncedWritesKept: 0 })
		expect(await titles(target)).toEqual(['from-backup'])
	})

	test("with sync configured, replace keeps this device's unsynced writes and its node", async () => {
		const source = await local()
		await todos(source).insert({ title: 'from-backup' })
		const target = await synced()
		const node = target.getStore().getNodeId()
		await todos(target).insert({ title: 'unsynced-here' })
		const result = await target.importBackup(await source.exportBackup())
		expect(result).toMatchObject({ success: true, unsyncedWritesKept: 1 })
		expect(await titles(target)).toEqual(['from-backup', 'unsynced-here'])
		expect(target.getStore().getNodeId()).toBe(node)
		expect(target.getSyncEngine()).not.toBeNull()

		const refused = await target.importBackup(await source.exportBackup(), {
			keepUnsyncedWrites: false,
		})
		expect(refused).toMatchObject({ success: false, errorCode: 'BACKUP_KEEP_UNSYNCED_REQUIRED' })
	})

	test('merge mode replays through the app pipeline and keeps the node id', async () => {
		const source = await local()
		await todos(source).insert({ title: 'merged-in' })
		const target = await local()
		const node = target.getStore().getNodeId()
		await todos(target).insert({ title: 'mine' })
		const result = await target.importBackup(await source.exportBackup(), { merge: true })
		expect(result.success).toBe(true)
		expect(result.operationsRestored).toBe(1)
		expect(await titles(target)).toEqual(['merged-in', 'mine'])
		expect(target.getStore().getNodeId()).toBe(node)
	})
})
