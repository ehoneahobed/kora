import { type KoraEvent, defineSchema, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { StoragePersistence } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createApp } from './create-app'
import { createStorageApi, hasUnsyncedOperations, wireStoragePersistence } from './storage-accessor'
import type { AuthSyncBinding } from './types'

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

describe('durable storage off the startup path (NEW-STORE-4)', () => {
	/** Firefox-like StorageManager: persist() prompts and never settles in a test. */
	function stubPendingPrompt(): { persistCalls: () => number } {
		let calls = 0
		vi.stubGlobal('navigator', {
			storage: {
				persist: () => {
					calls++
					return new Promise<boolean>(() => {})
				},
				persisted: async () => false,
			},
		})
		return { persistCalls: () => calls }
	}

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	test('app.ready resolves while a persist() prompt is pending; boot only checks persisted()', async () => {
		const stub = stubPendingPrompt()
		const app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		const events: KoraEvent[] = []
		app.on('storage:persistence', (event) => events.push(event))
		await app.ready
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(stub.persistCalls()).toBe(0)
		expect(events).toEqual([{ type: 'storage:persistence', state: 'checked', persisted: false }])
		expect(app.storage.persistence.status()).toMatchObject({ state: 'best-effort' })

		// The first local write requests persistence in the background, never awaited.
		const todos = (app as unknown as Record<string, { insert(v: unknown): Promise<unknown> }>).todos
		await todos?.insert({ title: 'a' })
		await todos?.insert({ title: 'b' })
		expect(stub.persistCalls()).toBe(1)
		expect(app.storage.persistence.status().requested).toBe(true)
		await app.close()
	})

	test("store.persistence: 'manual' never requests on its own", async () => {
		const stub = stubPendingPrompt()
		const app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:', persistence: 'manual' },
		})
		await app.ready
		const todos = (app as unknown as Record<string, { insert(v: unknown): Promise<unknown> }>).todos
		await todos?.insert({ title: 'a' })
		expect(stub.persistCalls()).toBe(0)
		void app.storage.persistence.request()
		expect(stub.persistCalls()).toBe(1)
		await app.close()
	})

	test('sign-in (a transition into authenticated) requests persistence', async () => {
		let persistCalls = 0
		const persistence = new StoragePersistence({
			storage: {
				persisted: async () => false,
				persist: async () => {
					persistCalls++
					return false
				},
			},
		})
		let state: 'signed-out' | 'authenticated' = 'signed-out'
		const listeners = new Set<() => void>()
		const binding = {
			auth: async () => ({ token: '' }),
			resolveSyncState: async () =>
				state === 'authenticated'
					? ({ state: 'authenticated', userId: 'u', token: 't' } as const)
					: ({ state: 'signed-out', mayConnectAnonymously: false } as const),
			subscribe: (listener: () => void) => {
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
		}
		const off = wireStoragePersistence(
			{ schema },
			new SimpleEventEmitter(),
			persistence,
			binding as unknown as AuthSyncBinding,
		)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(persistCalls).toBe(0)
		state = 'authenticated'
		for (const listener of listeners) listener()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(persistCalls).toBe(1)
		off()
		expect(listeners.size).toBe(0)
	})
})
