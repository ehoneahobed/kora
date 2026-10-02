import { defineSchema, t } from '@korajs/core'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createStorageApi, hasUnsyncedOperations } from './storage-accessor'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

const insertOp =
	"INSERT INTO _kora_ops_todos (id, node_id, type, record_id, timestamp, sequence_number, causal_deps, schema_version) VALUES ('op-1', 'n', 'insert', 'r', '0', 1, '[]', 1)"

describe('hasUnsyncedOperations', () => {
	let db: BetterSqlite3Adapter

	beforeEach(async () => {
		db = new BetterSqlite3Adapter(':memory:')
		await db.open(schema)
	})

	afterEach(async () => {
		await db.close()
	})

	test('a queued outbound operation is unsynced', async () => {
		await db.execute("INSERT INTO _kora_sync_queue (id, payload) VALUES ('op-1', '{}')")
		await expect(hasUnsyncedOperations(db, true)).resolves.toBe(true)
	})

	test('with sync configured, logged operations that left the queue are synced', async () => {
		await db.execute(insertOp)
		await expect(hasUnsyncedOperations(db, true)).resolves.toBe(false)
	})

	test('a local-only app treats every logged operation as unsynced', async () => {
		await db.execute(insertOp)
		await expect(hasUnsyncedOperations(db, false)).resolves.toBe(true)
	})

	test('an empty database has nothing unsynced', async () => {
		await expect(hasUnsyncedOperations(db, false)).resolves.toBe(false)
	})
})

describe('app.storage outside browsers', () => {
	test('listDatabases is empty and deleteDatabase refuses', async () => {
		const api = createStorageApi({ schema })
		await expect(api.listDatabases()).resolves.toEqual([])
		await expect(api.deleteDatabase('x')).rejects.toMatchObject({ code: 'STORAGE_UNSUPPORTED' })
	})
})
