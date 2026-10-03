/**
 * RT-70: a record that owns quarantined operations (rows the startup log-integrity scan
 * could not read) has an incomplete log. Its pre-fold row is kept as a snapshot base,
 * and the remaining and later operations fold onto it, on SQLite and Postgres; records
 * with a complete log still fold from it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import { PostgresServerStore } from '../../src/store/postgres-server-store'
import type { FoldMigrationReport } from '../../src/store/record-fold'
import type { ServerStore } from '../../src/store/server-store'
import { createSqliteServerStore } from '../../src/store/sqlite-server-store'

const PG_URL = process.env.KORA_PG_TEST_URL

const schema = defineSchema({
	version: 1,
	collections: {
		notes: {
			fields: {
				title: t.string(),
				body: t.string().optional(),
				tags: t.array(t.string()).default([]),
			},
		},
	},
})

function op(id: string, recordId: string, wall: number, partial: Partial<Operation>): Operation {
	return {
		id,
		nodeId: 'device-a',
		type: 'insert',
		collection: 'notes',
		recordId,
		data: {},
		previousData: null,
		timestamp: { wallTime: 1_790_000_000_000 + wall, logical: 0, nodeId: 'device-a' },
		sequenceNumber: wall,
		causalDeps: [],
		schemaVersion: 1,
		...partial,
	}
}

/** The seeded history: r1 (insert to be quarantined), r2 (update to be quarantined), r3 (clean). */
const HISTORY: Operation[] = [
	op('r1-insert', 'r1', 1, { data: { title: 'kept title', body: 'b0', tags: ['x'] } }),
	op('r2-insert', 'r2', 2, { data: { title: 'second', tags: [] } }),
	op('r2-update', 'r2', 3, {
		type: 'update',
		data: { title: 'second, edited', tags: ['y'] },
		previousData: { title: 'second', tags: [] },
	}),
	op('r3-insert', 'r3', 4, { data: { title: 'third' } }),
]
const QUARANTINED = ['r1-insert', 'r2-update']

type FoldReportingStore = ServerStore & { getFoldMigrationReport(): FoldMigrationReport }

interface Harness {
	open: () => Promise<FoldReportingStore>
	/** Make the given op rows unreadable and reset the one-time scan and fold states. */
	damage: (ids: string[]) => Promise<void>
	cleanup: () => Promise<void>
}

async function sqliteHarness(): Promise<Harness> {
	const dir = mkdtempSync(join(tmpdir(), 'kora-rt70-'))
	const filename = join(dir, 'server.db')
	const Database = createRequire(import.meta.url)('better-sqlite3')
	return {
		open: async () => createSqliteServerStore({ filename }),
		damage: async (ids) => {
			const raw = new Database(filename)
			for (const id of ids)
				raw.prepare("UPDATE operations SET data = '{broken' WHERE id = ?").run(id)
			raw.prepare('DELETE FROM kora_fold_state').run()
			raw
				.prepare(
					"DELETE FROM kora_server_meta WHERE key IN ('log_integrity_scan_v1', 'fold_plan_fingerprint')",
				)
				.run()
			raw.close()
		},
		cleanup: async () => rmSync(dir, { recursive: true, force: true }),
	}
}

const pgClients: Array<ReturnType<typeof postgres>> = []
afterAll(async () => {
	for (const client of pgClients) await client.end()
})

async function postgresHarness(): Promise<Harness> {
	const name = `kora_rt70_${process.pid}_${Date.now()}`
	const admin = postgres(PG_URL as string, { max: 1, onnotice: () => {} })
	await admin.unsafe(`CREATE SCHEMA ${name}`)
	await admin.end()
	const client = postgres(PG_URL as string, {
		max: 4,
		onnotice: () => {},
		connection: { search_path: name },
	})
	pgClients.push(client)
	return {
		open: async () => new PostgresServerStore(drizzle(client)),
		damage: async (ids) => {
			for (const id of ids) await client`UPDATE operations SET data = '{broken' WHERE id = ${id}`
			await client.unsafe('DELETE FROM kora_fold_state')
			await client.unsafe(
				"DELETE FROM kora_server_meta WHERE key IN ('log_integrity_scan_v1', 'fold_plan_fingerprint')",
			)
		},
		cleanup: async () => {},
	}
}

const harnesses: Array<[string, () => Promise<Harness>]> = [['sqlite', sqliteHarness]]
if (PG_URL) harnesses.push(['postgres', postgresHarness])

describe.each(harnesses)('%s: records with quarantined history (RT-70)', (_kind, make) => {
	test('the kept row is the base for the startup fold and every later write', async () => {
		const harness = await make()
		const errors: string[] = []
		const original = console.error
		console.error = (...args: unknown[]) => errors.push(args.join(' '))
		try {
			const seed = await harness.open()
			await seed.setSchema(schema)
			for (const o of HISTORY) expect(await seed.applyRemoteOperation(o)).toBe('applied')
			await seed.close()
			await harness.damage(QUARANTINED)

			const store = await harness.open()
			await store.setSchema(schema)
			expect(store.getFoldMigrationReport()).toMatchObject({ skippedUnclean: 2 })
			expect(errors.some((line) => line.includes('quarantined'))).toBe(true)

			// r1: its insert is quarantined (no operation left). The row survives with a
			// fold state, so a scope entry and a preview see it.
			expect(await store.findRecord('notes', 'r1')).toMatchObject({ title: 'kept title' })
			expect(await store.getRecordFoldState?.('notes', 'r1')).not.toBeNull()
			// r2: its update is quarantined; the edit survives.
			expect(await store.findRecord('notes', 'r2')).toMatchObject({
				title: 'second, edited',
				tags: ['y'],
			})

			// Later writes fold onto the kept rows.
			await store.applyRemoteOperation(
				op('r1-later', 'r1', 10, {
					type: 'update',
					data: { body: 'b1' },
					previousData: { body: 'b0' },
				}),
			)
			await store.applyRemoteOperation(
				op('r2-later', 'r2', 11, { type: 'update', data: { body: 'z' }, previousData: {} }),
			)
			expect(await store.findRecord('notes', 'r1')).toMatchObject({
				title: 'kept title',
				body: 'b1',
				tags: ['x'],
			})
			expect(await store.findRecord('notes', 'r2')).toMatchObject({
				title: 'second, edited',
				tags: ['y'],
				body: 'z',
			})
			// A late write older than the kept values does not override them.
			await store.applyRemoteOperation(
				op('r2-stale', 'r2', 2, {
					nodeId: 'device-b',
					timestamp: { wallTime: 1_790_000_000_002, logical: 5, nodeId: 'device-b' },
					sequenceNumber: 1,
					type: 'update',
					data: { title: 'stale' },
					previousData: {},
				}),
			)
			expect((await store.findRecord('notes', 'r2'))?.title).toBe('second, edited')
			// r3 has a complete log and folds from it.
			expect(await store.findRecord('notes', 'r3')).toMatchObject({ title: 'third' })
			await store.close()

			// A restart keeps everything (the states are current; nothing re-folds them).
			const again = await harness.open()
			await again.setSchema(schema)
			expect(again.getFoldMigrationReport()).toMatchObject({ records: 0 })
			expect(await again.findRecord('notes', 'r1')).toMatchObject({
				title: 'kept title',
				body: 'b1',
			})
			await again.close()
		} finally {
			console.error = original
			await harness.cleanup()
		}
	}, 60_000)
})
