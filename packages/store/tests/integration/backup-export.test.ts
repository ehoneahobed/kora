import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { readBackupManifest } from '../../src/backup/backup'
import { Store } from '../../src/store/store'

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

describe('exportBackup', () => {
	let store: Store

	afterEach(async () => {
		if (store) {
			await store.close()
		}
	})

	test('reads operation log with HLC timestamps without JSON.parse errors', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:backup-export')
		store = new Store({ schema, adapter, nodeId: 'backup-export-node' })
		await store.open()

		const todos = store.collection('todos')
		const record = await todos.insert({ title: 'Backup me' })
		await todos.update(record.id, { completed: true })

		const backup = await store.exportBackup()
		const manifest = readBackupManifest(backup)

		expect(manifest.operationCount).toBeGreaterThanOrEqual(2)
		expect(manifest.collections).toContain('todos')
	})
})
