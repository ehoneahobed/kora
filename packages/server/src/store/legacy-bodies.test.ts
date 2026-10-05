import { computeOperationId, defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import Database from 'better-sqlite3'
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { describe, expect, test } from 'vitest'
import { LEGACY_BODIES_META_KEY } from './legacy-bodies'
import { PostgresServerStore } from './postgres-server-store'
import type { ServerStore } from './server-store'
import { SqliteServerStore } from './sqlite-server-store'

/**
 * RT-85: the fold has no legacy clear rule, so the beta.12 clears a beta.12 (or older) server stored
 * (JSON without the cleared member) are made explicit once, when the id proves them. A
 * body an earlier release rewrote (a schema-transformed copy) proves nothing and keeps
 * folding as written.
 */
const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), assignee: t.string().optional() } } },
})

/** A beta.12 log: two inserts, a proven clear on n1, and a rewritten copy on n2. */
async function legacyOps(): Promise<Record<string, Operation>> {
	const at = (wallTime: number) => ({ wallTime, logical: 0, nodeId: 'b13' })
	const base = { nodeId: 'b13', collection: 'notes', causalDeps: [], schemaVersion: 1 }
	const insert = async (recordId: string, seq: number): Promise<Operation> => {
		const body = {
			...base,
			type: 'insert' as const,
			recordId,
			data: { title: 'x', assignee: 'bob' },
			previousData: null,
			timestamp: at(1000 + seq),
			sequenceNumber: seq,
		}
		return { ...body, id: await computeOperationId(body, 1) }
	}
	// The id covers `hashed`; the stored body is `stored` (JSON dropped the member, or
	// an earlier release rewrote it).
	const update = async (
		recordId: string,
		seq: number,
		hashed: Record<string, unknown>,
		stored: Record<string, unknown>,
	): Promise<Operation> => {
		const body = {
			...base,
			type: 'update' as const,
			recordId,
			previousData: { title: 'x', assignee: 'bob' },
			timestamp: at(2000 + seq),
			sequenceNumber: seq,
			data: hashed,
		}
		return { ...body, id: await computeOperationId(body, 1), data: stored }
	}
	return {
		insert: await insert('n1', 1),
		insert2: await insert('n2', 2),
		proven: await update('n1', 3, { title: 'y', assignee: null }, { title: 'y' }),
		rewritten: await update('n2', 4, { title: 'original', other: 1 }, { title: 'transformed' }),
	}
}

async function exercise(open: () => Promise<{ store: ServerStore; reset: () => Promise<void> }>) {
	const ops = await legacyOps()
	const { store, reset } = await open()
	await store.setSchema(schema)
	for (const key of ['insert', 'insert2', 'proven', 'rewritten']) {
		await store.applyRemoteOperation(ops[key] as Operation)
	}
	// What an upgraded beta.12 database holds: the marker is absent.
	await reset()
	await store.setSchema(schema)
	expect(await store.findRecord('notes', 'n1')).toMatchObject({ title: 'y', assignee: null })
	expect(await store.findRecord('notes', 'n2')).toMatchObject({
		title: 'transformed',
		assignee: 'bob',
	})
	const stored = await store.getRecordOperations?.('notes', 'n1')
	expect(stored?.find((op) => op.id === ops.proven?.id)?.data).toEqual({
		title: 'y',
		assignee: null,
	})
}

describe('legacy beta.12 clears made explicit once on the server (RT-85)', () => {
	test('SQLite', async () => {
		const sqlite = new Database(':memory:')
		await exercise(async () => ({
			store: new SqliteServerStore(drizzleSqlite(sqlite), 'server-1'),
			reset: async () => {
				sqlite.prepare('DELETE FROM kora_server_meta WHERE key = ?').run(LEGACY_BODIES_META_KEY)
			},
		}))
	})

	test.skipIf(!process.env.KORA_PG_TEST_URL)('Postgres', async () => {
		const schemaName = `kora_legacy_bodies_${process.pid}`
		const admin = postgres(process.env.KORA_PG_TEST_URL as string, { max: 1 })
		await admin.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
		await admin.unsafe(`CREATE SCHEMA ${schemaName}`)
		await admin.end()
		const client = postgres(process.env.KORA_PG_TEST_URL as string, {
			max: 4,
			connection: { search_path: schemaName },
		})
		try {
			await exercise(async () => ({
				store: new PostgresServerStore(drizzlePg(client), 'server-1'),
				reset: async () => {
					await client.unsafe('DELETE FROM kora_server_meta WHERE key = $1', [
						LEGACY_BODIES_META_KEY,
					])
				},
			}))
		} finally {
			await client.end()
		}
	})
})
