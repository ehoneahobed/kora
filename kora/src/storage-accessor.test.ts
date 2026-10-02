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

	describe('own operations above the acknowledged prefix (RT-41)', () => {
		const ownOp = (id: string, node: string, seq: number): string =>
			`INSERT INTO _kora_ops_todos (id, node_id, type, record_id, timestamp, sequence_number, causal_deps, schema_version) VALUES ('${id}', '${node}', 'insert', 'r', '0', ${seq}, '[]', 1)`

		test('the database node with no recorded prefix counts from 0', async () => {
			await db.execute("INSERT INTO _kora_meta (key, value) VALUES ('node_id', 'me')")
			await db.execute(ownOp('a', 'me', 1))
			await expect(hasUnsyncedOperations(db, true)).resolves.toBe(true)
		})

		test('own operations at or below the prefix are synced; above it they are not', async () => {
			await db.execute("INSERT INTO _kora_meta (key, value) VALUES ('node_id', 'me')")
			await db.execute(
				`INSERT INTO _kora_meta (key, value) VALUES ('own_acked_through', '{"nodeId":"me","sequence":1}')`,
			)
			await db.execute(ownOp('a', 'me', 1))
			await expect(hasUnsyncedOperations(db, true)).resolves.toBe(false)
			await db.execute(ownOp('b', 'me', 2))
			await expect(hasUnsyncedOperations(db, true)).resolves.toBe(true)
		})

		test('a terminally rejected operation is not unsynced', async () => {
			await db.execute("INSERT INTO _kora_meta (key, value) VALUES ('node_id', 'me')")
			await db.execute(ownOp('refused', 'me', 1))
			await db.execute(
				'CREATE TABLE _kora_terminal_rejections (operation_id TEXT PRIMARY KEY, node_id TEXT, sequence_number INTEGER, code TEXT NOT NULL, rejected_at INTEGER NOT NULL)',
			)
			await db.execute(
				"INSERT INTO _kora_terminal_rejections VALUES ('refused', 'me', 1, 'FORBIDDEN', 0)",
			)
			await expect(hasUnsyncedOperations(db, true)).resolves.toBe(false)
		})

		test("another local node (a closed tab's) is checked against its own prefix key", async () => {
			await db.execute(
				'CREATE TABLE _kora_local_nodes (node_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, accepted INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0, refused_cycle INTEGER)',
			)
			await db.execute("INSERT INTO _kora_local_nodes (node_id, created_at) VALUES ('tab-1', 0)")
			await db.execute(
				"INSERT INTO _kora_meta (key, value) VALUES ('own_acked_through:tab-1', '2')",
			)
			await db.execute(ownOp('a', 'tab-1', 2))
			await expect(hasUnsyncedOperations(db, true)).resolves.toBe(false)
			await db.execute(ownOp('b', 'tab-1', 3))
			await expect(hasUnsyncedOperations(db, true)).resolves.toBe(true)
		})

		test("another device's operations never count", async () => {
			await db.execute("INSERT INTO _kora_meta (key, value) VALUES ('node_id', 'me')")
			await db.execute(ownOp('peer', 'someone-else', 9))
			await expect(hasUnsyncedOperations(db, true)).resolves.toBe(false)
		})
	})
})

describe('app.storage outside browsers', () => {
	test('listDatabases is empty and deleteDatabase refuses', async () => {
		const api = createStorageApi({ schema })
		await expect(api.listDatabases()).resolves.toEqual([])
		await expect(api.deleteDatabase('x')).rejects.toMatchObject({ code: 'STORAGE_UNSUPPORTED' })
	})
})
