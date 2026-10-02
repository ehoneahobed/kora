import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MemoryServerStore } from './memory-server-store'
import { PostgresServerStore } from './postgres-server-store'
import {
	NODE_SEQ_UNIQUE_INDEX,
	SEQUENCE_ENFORCEMENT_EPOCH_KEY,
	SequenceConflictError,
	type ServerStore,
} from './server-store'
import { SqliteServerStore } from './sqlite-server-store'

/**
 * Sequence-enforcement epoch (Phase 2 seam W6 x SRV-4). beta.12 clients could write
 * two different operations under one (node, sequence) (STORE-1/2) and the server
 * stored both, or only one. The client's sequence repair keeps the first-by-id at the
 * old number and renumbers the others. If the server holds only the OTHER op of the
 * pair, the kept op must still be accepted: SEQUENCE_CONFLICT applies only against
 * holders stored after the epoch (the log's end when this release first opened it).
 */
const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

let n = 0
function op(sequenceNumber: number, overrides: Partial<Operation> = {}): Operation {
	n += 1
	return {
		id: `epoch-op-${n}`,
		nodeId: 'device-1',
		type: 'insert',
		collection: 'todos',
		recordId: `rec-${n}`,
		data: { title: `t${n}` },
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: n, nodeId: 'device-1' },
		sequenceNumber,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

/** One SQL-backed store kind: how to open it, run raw SQL, and reopen it. */
interface Kind {
	name: string
	open: () => Promise<ServerStore>
	exec: (statement: string) => Promise<Array<Record<string, unknown>>>
	indexPredicate: () => Promise<string | null>
}

function sqliteKind(): Kind & { reset: () => void } {
	let sqlite = new Database(':memory:')
	return {
		name: 'sqlite',
		reset: () => {
			sqlite = new Database(':memory:')
		},
		open: async () => {
			const store = new SqliteServerStore(drizzleSqlite(sqlite), 'server-1')
			await store.setSchema(schema)
			return store
		},
		exec: async (statement) => {
			const prepared = sqlite.prepare(statement)
			if (prepared.reader) return prepared.all() as Array<Record<string, unknown>>
			prepared.run()
			return []
		},
		indexPredicate: async () => {
			const row = sqlite
				.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
				.get(NODE_SEQ_UNIQUE_INDEX) as { sql: string } | undefined
			return row?.sql ?? null
		},
	}
}

const PG_URL = process.env.KORA_PG_TEST_URL
const PG_SCHEMA = 'kora_test_seq_epoch'

function pgKind(client: ReturnType<typeof postgres>): Kind {
	return {
		name: 'postgres',
		open: async () => {
			const store = new PostgresServerStore(drizzlePg(client), 'server-1')
			await store.setSchema(schema)
			return store
		},
		exec: async (statement) => (await client.unsafe(statement)) as Array<Record<string, unknown>>,
		indexPredicate: async () => {
			const rows = await client.unsafe(
				`SELECT indexdef FROM pg_indexes WHERE schemaname = '${PG_SCHEMA}' AND indexname = '${NODE_SEQ_UNIQUE_INDEX}'`,
			)
			return (rows[0] as { indexdef?: string } | undefined)?.indexdef ?? null
		},
	}
}

/**
 * Make the current log look like a beta.12 server's: no epoch recorded and no
 * partial index, so the next open records the epoch at the log's end.
 */
async function forgetEnforcement(kind: Kind): Promise<void> {
	await kind.exec(`DELETE FROM kora_server_meta WHERE key = '${SEQUENCE_ENFORCEMENT_EPOCH_KEY}'`)
	await kind.exec(`DROP INDEX IF EXISTS ${NODE_SEQ_UNIQUE_INDEX}`)
}

function contract(getKind: () => Kind): void {
	let warn: ReturnType<typeof vi.spyOn>
	beforeEach(() => {
		warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	})
	afterEach(() => {
		warn.mockRestore()
	})

	test('a fresh store refuses a second op under a (node, sequence) and always has the partial index', async () => {
		const kind = getKind()
		const store = await kind.open()
		expect(await store.applyRemoteOperation(op(5))).toBe('applied')
		await expect(store.applyRemoteOperation(op(5))).rejects.toBeInstanceOf(SequenceConflictError)
		expect(await kind.indexPredicate()).toMatch(/delivery_seq\)? > \(?0/)
		await store.close()
	})

	test('an op whose only holder predates the epoch is stored; enforcement holds after it', async () => {
		const kind = getKind()
		const before = await kind.open()
		const legacyHolder = op(5) // the op the client repair renumbered away
		await before.applyRemoteOperation(legacyHolder)
		await before.applyRemoteOperation(op(6))
		await before.close()
		await forgetEnforcement(kind)

		const store = await kind.open()
		const kept = op(5) // the op the client repair kept at 5
		expect(await store.applyRemoteOperation(kept)).toBe('applied')
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(legacyHolder.id))
		// Both are stored and dedup by id.
		expect(await store.applyRemoteOperation(kept)).toBe('duplicate')
		expect(await store.applyRemoteOperation(legacyHolder)).toBe('duplicate')
		// A third op under 5 conflicts with `kept`, stored under enforcement.
		await expect(store.applyRemoteOperation(op(5))).rejects.toMatchObject({
			code: 'SEQUENCE_CONFLICT',
			existingOperationId: kept.id,
		})
		// The partial index exists and starts above the legacy rows (epoch = 2).
		expect(await kind.indexPredicate()).toMatch(/delivery_seq\)? > \(?2/)
		await store.close()
	})

	test('a legacy pair stored under one sequence: re-applying either is a duplicate', async () => {
		const kind = getKind()
		const before = await kind.open()
		const a = op(7)
		const b = op(8)
		await before.applyRemoteOperation(a)
		await before.applyRemoteOperation(b)
		await before.close()
		await forgetEnforcement(kind)
		// beta.12 stored both under sequence 7.
		await kind.exec(`UPDATE operations SET sequence_number = 7 WHERE id = '${b.id}'`)

		const store = await kind.open()
		expect(await store.applyRemoteOperation(a)).toBe('duplicate')
		expect(await store.applyRemoteOperation(b)).toBe('duplicate')
		expect(await kind.indexPredicate()).not.toBeNull()

		// A replace-mode restore of that log keeps both, and the next start keeps the index.
		const backup = await store.exportBackup()
		const restored = await store.importBackup(backup, false)
		expect(restored).toEqual({ operationsRestored: 2, success: true })
		expect(await store.applyRemoteOperation(b)).toBe('duplicate')
		expect(await kind.indexPredicate()).not.toBeNull()
		await store.close()
	})
}

describe('sequence enforcement epoch: SQLite', () => {
	const kind = sqliteKind()
	beforeEach(() => kind.reset())
	contract(() => kind)
})

describe.skipIf(!PG_URL)('sequence enforcement epoch: Postgres', () => {
	const client = PG_URL
		? postgres(PG_URL, { max: 4, onnotice: () => {}, connection: { search_path: PG_SCHEMA } })
		: (null as unknown as ReturnType<typeof postgres>)
	beforeEach(async () => {
		await client.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`)
		await client.unsafe(`CREATE SCHEMA ${PG_SCHEMA}`)
	})
	afterAll(async () => {
		await client.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`)
		await client.end()
	})
	contract(() => pgKind(client))
})

describe('sequence enforcement epoch: memory', () => {
	test('epoch 0: every holder is enforced', async () => {
		const store = new MemoryServerStore('server-1')
		await store.setSchema(schema)
		await store.applyRemoteOperation(op(3))
		await expect(store.applyRemoteOperation(op(3))).rejects.toBeInstanceOf(SequenceConflictError)
	})

	test('a replace-mode restore of a legacy pair keeps both; enforcement resumes above it', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const source = new MemoryServerStore('server-1')
		await source.setSchema(schema)
		const a = op(4)
		const b = op(9)
		await source.applyRemoteOperation(a)
		await source.applyRemoteOperation(b)
		const backup = await source.exportBackup()
		// Rewrite b's sequence inside the backup the way beta.12 would have stored it.
		const legacy = new SqliteServerStore(drizzleSqlite(new Database(':memory:')), 'server-1')
		await legacy.importBackup(backup, false)
		const raw = (legacy as unknown as { db: ReturnType<typeof drizzleSqlite> }).db
		raw.run(sql.raw(`UPDATE operations SET sequence_number = 4 WHERE id = '${b.id}'`))
		const legacyBackup = await legacy.exportBackup()

		const store = new MemoryServerStore('server-1')
		await store.setSchema(schema)
		expect(await store.importBackup(legacyBackup, false)).toMatchObject({ success: true })
		expect(await store.applyRemoteOperation(a)).toBe('duplicate')
		expect(await store.applyRemoteOperation(b)).toBe('duplicate')
		const next = op(4)
		expect(await store.applyRemoteOperation(next)).toBe('applied')
		await expect(store.applyRemoteOperation(op(4))).rejects.toBeInstanceOf(SequenceConflictError)
		warn.mockRestore()
	})
})
