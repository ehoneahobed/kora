/**
 * A replace-mode restore that stops right after its replace transaction committed (a
 * crash, a failed step) leaves no record of the replaced log behind: the next start folds
 * every record from the restored log and indexes only what it holds. Postgres runs with
 * KORA_PG_TEST_URL.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Operation } from '@korajs/core'
import { defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import { ACCESS_INDEX_GENERATION_KEY } from '../access/membership-index'
import { PostgresServerStore } from './postgres-server-store'
import type { ServerStore } from './server-store'
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
function membership(recordId: string, userId: string): Operation {
	seq += 1
	return {
		id: `op-${seq}-${Math.random().toString(36).slice(2)}`,
		nodeId: 'server-node',
		type: 'insert',
		collection: 'members',
		recordId,
		data: { userId, group: 'documents:d', role: 'view' },
		previousData: null,
		timestamp: { wallTime: 1_000 + seq, logical: 0, nodeId: 'server-node' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	}
}

interface Transactional {
	transaction: (...args: unknown[]) => unknown
}

/**
 * Makes the first database transaction after the restore's replace transaction (the one
 * that rotates the index generation) fail, as a crash right after it would leave things.
 */
function failRightAfterReplace(
	db: Transactional,
	generation: () => string | undefined | Promise<string | undefined>,
): void {
	const original = db.transaction.bind(db)
	const before = generation()
	let replaced = false
	db.transaction = (...args: unknown[]) => {
		if (replaced) throw new Error('stopped after the replace transaction')
		const result = original(...args)
		if (result instanceof Promise) {
			return result.then(async (value) => {
				if ((await generation()) !== (await before)) replaced = true
				return value
			})
		}
		// Synchronous (SQLite): the generation read is synchronous too.
		if (generation() !== before) replaced = true
		return result
	}
}

async function expectOnlyRestoredRecords(
	store: ServerStore,
	rows: () => Promise<string[]> | string[],
): Promise<void> {
	expect((await rows()).sort()).toEqual(['m-kept'])
	expect(await store.getMembershipIntervals?.('eve')).toEqual([])
	expect((await store.getMembershipIntervals?.('ann'))?.length).toBe(1)
}

describe('sqlite: a restore stopped after its replace transaction', () => {
	test('the next start keeps and indexes only the restored records', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'kora-restore-'))
		const filename = join(dir, 'server.db')
		try {
			const store = createSqliteServerStore({ filename })
			await store.setSchema(schema)
			await store.applyRemoteOperation(membership('m-kept', 'ann'))
			const backup = await store.exportBackup()
			// Written after the backup: the restore removes it.
			await store.applyRemoteOperation(membership('m-removed', 'eve'))
			const db = (store as unknown as { db: Transactional & { all: (q: unknown) => unknown[] } }).db
			const generation = (): string | undefined =>
				(
					db.all(
						sql`SELECT value FROM kora_server_meta WHERE key = ${ACCESS_INDEX_GENERATION_KEY}`,
					) as { value: string }[]
				)[0]?.value
			failRightAfterReplace(db, generation)
			await expect(store.importBackup(backup, false)).rejects.toThrow()
			await store.close()

			const restarted = createSqliteServerStore({ filename })
			await restarted.setSchema(schema)
			const restartedDb = (restarted as unknown as { db: { all: (q: unknown) => unknown[] } }).db
			await expectOnlyRestoredRecords(restarted, () =>
				(restartedDb.all(sql`SELECT id FROM members`) as { id: string }[]).map((row) => row.id),
			)
			await restarted.close()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

const PG_URL = process.env.KORA_PG_TEST_URL
const clients: ReturnType<typeof postgres>[] = []

describe.skipIf(!PG_URL)('postgres: a restore stopped after its replace transaction', () => {
	afterAll(async () => {
		await Promise.all(clients.map((client) => client.end()))
	})

	test('the next start keeps and indexes only the restored records', async () => {
		const name = `kora_restore_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
		const admin = postgres(PG_URL ?? '', { max: 1 })
		await admin.unsafe(`CREATE SCHEMA ${name}`)
		await admin.end()
		const open = async (): Promise<PostgresServerStore> => {
			const client = postgres(PG_URL ?? '', { max: 4, connection: { search_path: name } })
			clients.push(client)
			const store = new PostgresServerStore(drizzle(client), 'server-node')
			await store.setSchema(schema)
			return store
		}
		const store = await open()
		await store.applyRemoteOperation(membership('m-kept', 'ann'))
		const backup = await store.exportBackup()
		await store.applyRemoteOperation(membership('m-removed', 'eve'))
		const db = (
			store as unknown as { db: Transactional & { execute: (q: unknown) => Promise<unknown> } }
		).db
		const generation = async (): Promise<string | undefined> =>
			(
				(await db.execute(
					sql`SELECT value FROM kora_server_meta WHERE key = ${ACCESS_INDEX_GENERATION_KEY}`,
				)) as { value: string }[]
			)[0]?.value
		failRightAfterReplace(db, generation)
		await expect(store.importBackup(backup, false)).rejects.toThrow()

		const restarted = await open()
		const restartedDb = (
			restarted as unknown as { db: { execute: (q: unknown) => Promise<unknown> } }
		).db
		await expectOnlyRestoredRecords(restarted, async () =>
			((await restartedDb.execute(sql`SELECT id FROM members`)) as { id: string }[]).map(
				(row) => row.id,
			),
		)
	})
})
