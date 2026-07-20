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

	test('restore round-trips per-field versions so field-level LWW keeps working', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:backup-fv')
		store = new Store({ schema, adapter, nodeId: 'backup-fv-node' })
		await store.open()

		const todos = store.collection('todos')
		const record = await todos.insert({ title: 'original' })
		await todos.update(record.id, { completed: true })

		const sourceRows = await adapter.query<{ _field_versions: string }>(
			'SELECT _field_versions FROM todos WHERE id = ?',
			[record.id],
		)
		const sourceVersions = sourceRows[0]?._field_versions
		expect(sourceVersions).toBeTruthy()

		const backup = await store.exportBackup({ includeRecords: true })
		await store.close()

		// Restore into a fresh store.
		const restoreAdapter = new BetterSqlite3Adapter(':memory:backup-fv-restore')
		store = new Store({ schema, adapter: restoreAdapter, nodeId: 'backup-fv-restore-node' })
		await store.open()
		const result = await store.importBackup(backup)
		expect(result.success).toBe(true)

		// The per-field last-writer stamps survived the round trip byte-for-byte —
		// without them, a post-restore sync would fall back to row-level LWW and
		// could resolve old conflicts differently than every other device.
		const restoredRows = await restoreAdapter.query<{ _field_versions: string }>(
			'SELECT _field_versions FROM todos WHERE id = ?',
			[record.id],
		)
		expect(restoredRows[0]?._field_versions).toBe(sourceVersions)

		// And field-level LWW still functions: a stale remote update to `title`
		// must lose against the restored stamp.
		const staleResult = await store.applyRemoteOperation({
			id: 'op-stale-after-restore',
			nodeId: 'other-node',
			type: 'update',
			collection: 'todos',
			recordId: record.id,
			data: { title: 'stale' },
			previousData: { title: 'original' },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'other-node' },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		})
		expect(staleResult).toBe('applied')
		const after = await store.collection('todos').findById(record.id)
		expect(after?.title).toBe('original')
	})
})
