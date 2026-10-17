import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
/**
 * Membership index rebuilds across instances of one database: every rebuild keeps its
 * own marker, a rebuild finishing never clears another's, and an instance learns of
 * another's restore at its next write. Postgres runs with KORA_PG_TEST_URL.
 */
import type { Operation, OperationTransform } from '@korajs/core'
import { defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import { MemoryServerStore } from './memory-server-store'
import { PostgresServerStore } from './postgres-server-store'
import { createSqliteServerStore } from './sqlite-server-store'

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit', 'manage'],
		groups: { documents: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: {
			fields: { userId: t.string(), group: t.string(), role: t.string() },
			access: { read: memberOfKey('group') },
		},
		documents: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: member('id'), create: owner('ownerId'), update: member('id', 'edit') },
		},
	},
})

let seq = 0
function op(input: Partial<Operation> & Pick<Operation, 'collection' | 'recordId'>): Operation {
	seq += 1
	return {
		id: `op-${seq}-${Math.random().toString(36).slice(2)}`,
		nodeId: 'server-node',
		type: 'insert',
		data: {},
		previousData: null,
		timestamp: { wallTime: 1_000 + seq, logical: 0, nodeId: 'server-node' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...input,
	}
}

const promoteEditors: OperationTransform = {
	fromVersion: 1,
	toVersion: 1,
	transform: (operation) => operation,
}

describe('memory store: a re-fold that failed part-way is retried in full', () => {
	test('retrying the same transforms rebuilds the index', async () => {
		const store = new MemoryServerStore('server-node')
		const toV2 = (operation: Operation): Operation => ({ ...operation, schemaVersion: 2 })
		await store.setSchema(
			{ ...schema, version: 2 },
			{ operationTransforms: [{ fromVersion: 1, toVersion: 2, transform: toV2 }] },
		)
		await store.applyRemoteOperation(
			op({
				collection: 'members',
				recordId: 'm1',
				data: { userId: 'u', group: 'documents:d', role: 'view' },
			}),
		)
		let fail = true
		const flaky: OperationTransform = {
			fromVersion: 1,
			toVersion: 2,
			transform: (operation) => {
				if (fail) throw new Error('transform failed')
				return toV2(operation)
			},
		}
		await expect(store.setOperationTransforms([flaky])).rejects.toThrow('transform failed')
		expect(store.isAccessIndexReady()).toBe(false)
		fail = false
		await store.setOperationTransforms([flaky])
		expect(store.isAccessIndexReady()).toBe(true)
	})
})

const PG_URL = process.env.KORA_PG_TEST_URL
const clients: ReturnType<typeof postgres>[] = []

async function sharedPostgres(): Promise<[PostgresServerStore, PostgresServerStore]> {
	const name = `kora_markers_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
	const admin = postgres(PG_URL ?? '', { max: 1 })
	await admin.unsafe(`CREATE SCHEMA ${name}`)
	await admin.end()
	const make = async (instance: string): Promise<PostgresServerStore> => {
		const client = postgres(PG_URL ?? '', { max: 4, connection: { search_path: name } })
		clients.push(client)
		const store = new PostgresServerStore(drizzle(client), 'server-node', undefined, {
			instanceId: instance,
		})
		await store.setSchema(schema)
		return store
	}
	const a = await make('a')
	return [a, await make('b')]
}

/**
 * Pauses `store`'s next index reconcile: `reached` resolves once the rebuild got there
 * (its marker is written), and the reconcile runs on `release()`.
 */
function pauseReconcile(store: object): { reached: Promise<void>; release: () => void } {
	let release = (): void => {}
	let arrive = (): void => {}
	const paused = new Promise<void>((resolve) => {
		release = resolve
	})
	const reached = new Promise<void>((resolve) => {
		arrive = resolve
	})
	const internals = store as { reconcileMembershipIndex: () => Promise<void> | void }
	const original = internals.reconcileMembershipIndex.bind(store)
	let first = true
	internals.reconcileMembershipIndex = async () => {
		if (first) {
			first = false
			arrive()
			await paused
		}
		return original()
	}
	return { reached, release }
}

/** The recovery rebuild a store started in the background, if any. */
function recoveryOf(store: object): Promise<void> | null {
	return (
		store as { accessIndex: { pendingRecovery: () => Promise<void> | null } }
	).accessIndex.pendingRecovery()
}

describe.skipIf(!PG_URL)('postgres: rebuilds on several instances', () => {
	afterAll(async () => {
		await Promise.all(clients.map((client) => client.end()))
	})

	test("a rebuild finishing never clears another instance's marker", async () => {
		const [a, b] = await sharedPostgres()
		const pause = pauseReconcile(a)
		// Instance a re-folds (its marker is written) and waits before its index rebuild.
		const first = a.setOperationTransforms([promoteEditors])
		await pause.reached
		// Instance b completes a rebuild of its own meanwhile: a's marker must stay.
		await b.setOperationTransforms([])
		expect((await b.getAccessIndexState()).rebuilding).toBe(true)
		expect(b.isAccessIndexReady()).toBe(false)
		pause.release()
		await first
		expect((await b.getAccessIndexState()).rebuilding).toBe(false)
		expect(b.isAccessIndexReady()).toBe(true)
		expect(a.isAccessIndexReady()).toBe(true)
	})

	test('overlapping rebuilds on one instance run one at a time, each with its own marker', async () => {
		const [a] = await sharedPostgres()
		const order: string[] = []
		let release = (): void => {}
		const paused = new Promise<void>((resolve) => {
			release = resolve
		})
		const internals = a as unknown as {
			reconcileMembershipIndex: () => Promise<void>
			rematerialize: () => Promise<unknown>
		}
		const reconcile = internals.reconcileMembershipIndex.bind(a)
		let firstReconcile = true
		let arrive = (): void => {}
		const reachedReconcile = new Promise<void>((resolve) => {
			arrive = resolve
		})
		internals.reconcileMembershipIndex = async () => {
			if (firstReconcile) {
				firstReconcile = false
				arrive()
				await paused
			}
			await reconcile()
			order.push('rebuilt')
		}
		const refold = internals.rematerialize.bind(a)
		internals.rematerialize = async () => {
			order.push('refold')
			return refold()
		}
		// The transform change (a new fold plan: it writes its marker) takes the first turn.
		const transforms = a.setOperationTransforms([promoteEditors])
		await reachedReconcile
		const operations = [transforms, a.setSchema(schema)]
		// The schema install queues behind the running hold; give it turns to (not) start.
		for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
		// The re-fold waits for its index rebuild; the schema install has not started.
		expect(order).toEqual(['refold'])
		expect((await a.getAccessIndexState()).rebuilding).toBe(true)
		expect(a.isAccessIndexReady()).toBe(false)
		release()
		await Promise.all(operations)
		expect(order).toEqual(['refold', 'rebuilt', 'refold', 'rebuilt'])
		expect((await a.getAccessIndexState()).rebuilding).toBe(false)
		expect(a.isAccessIndexReady()).toBe(true)
	})

	test("installing a schema on another instance never adopts a running rebuild's marker", async () => {
		const [a, b] = await sharedPostgres()
		const pause = pauseReconcile(a)
		const first = a.setOperationTransforms([promoteEditors])
		await pause.reached
		// b installs the schema (as at its start) while a's rebuild runs: a's marker is live.
		await b.setSchema(schema)
		expect((await b.getAccessIndexState()).rebuilding).toBe(true)
		expect(recoveryOf(b)).toBeNull()
		expect(b.isAccessIndexReady()).toBe(false)
		pause.release()
		await first
		expect((await b.getAccessIndexState()).rebuilding).toBe(false)
		expect(b.isAccessIndexReady()).toBe(true)
	})

	test('an abandoned marker is recovered by exactly one instance, outside any transaction', async () => {
		const [a, b] = await sharedPostgres()
		const db = (a as unknown as { db: { execute: (query: unknown) => Promise<unknown> } }).db
		await db.execute(
			sql`INSERT INTO kora_server_meta (key, value) VALUES ('access_index_rebuilding:gone:1', '0')`,
		)
		const installs: string[] = []
		for (const [name, store] of [
			['a', a],
			['b', b],
		] as const) {
			const internals = store as unknown as { installSchema: (...args: unknown[]) => Promise<void> }
			const install = internals.installSchema.bind(store)
			internals.installSchema = (...args: unknown[]) => {
				installs.push(name)
				return install(...args)
			}
		}
		// b reads inside a store transaction (as roleOf in a route transaction does): the
		// recovery it starts must not run on that transaction's connection.
		await b.transact(async (view) => {
			const state = await view.getAccessIndexState?.()
			expect(state?.rebuilding).toBe(true)
			return null
		})
		expect((await a.getAccessIndexState()).rebuilding).toBe(true)
		await Promise.all([recoveryOf(a), recoveryOf(b)])
		expect(installs).toHaveLength(1)
		expect((await a.getAccessIndexState()).rebuilding).toBe(false)
		expect((await b.getAccessIndexState()).rebuilding).toBe(false)
		expect(a.isAccessIndexReady()).toBe(true)
		expect(b.isAccessIndexReady()).toBe(true)
	})

	test("an instance sees another's restore at its next write, before any poll", async () => {
		const [a, b] = await sharedPostgres()
		const before = b.accessIndexGeneration()
		await a.importBackup(await a.exportBackup(), false)
		const after = (await a.getAccessIndexState()).generation
		expect(after).not.toBe(before)
		// b has not polled: its view is stale until a write takes the counter lock.
		expect(b.accessIndexGeneration()).toBe(before)
		await b.applyRemoteOperation(
			op({
				collection: 'members',
				recordId: 'm9',
				data: { userId: 'z', group: 'documents:x', role: 'view' },
			}),
		)
		expect(b.accessIndexGeneration()).toBe(after)
	})
})

describe('sqlite: rebuild markers of processes sharing one file', () => {
	test('a live marker is kept by a schema install; an abandoned one is recovered', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'kora-markers-'))
		const a = createSqliteServerStore({ filename: join(dir, 'server.db') })
		const b = createSqliteServerStore({ filename: join(dir, 'server.db') })
		try {
			await a.setSchema(schema)
			await b.setSchema(schema)
			const db = (a as unknown as { db: { run: (query: unknown) => void } }).db
			const live = String(Date.now() + 60_000)
			db.run(
				sql`INSERT INTO kora_server_meta (key, value) VALUES ('access_index_rebuilding:other:1', ${live})`,
			)
			await b.setSchema(schema)
			expect((await b.getAccessIndexState()).rebuilding).toBe(true)
			expect(recoveryOf(b)).toBeNull()
			// The process holding it stops renewing: once the lease ran out, a read recovers it.
			db.run(
				sql`UPDATE kora_server_meta SET value = '0' WHERE key = 'access_index_rebuilding:other:1'`,
			)
			expect((await b.getAccessIndexState()).rebuilding).toBe(true)
			await recoveryOf(b)
			expect((await b.getAccessIndexState()).rebuilding).toBe(false)
			expect(b.isAccessIndexReady()).toBe(true)
		} finally {
			await a.close()
			await b.close()
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
