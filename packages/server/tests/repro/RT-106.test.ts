/**
 * RT-106 repro (Phase 4, found while checking `kora migrate` against the fold, RT-105):
 * after a schema upgrade ADDS a field with a default, the server stores materialize the
 * records written before it with the field NULL (memory: absent), while every device
 * materializes them with the default.
 *
 * A record whose operations predate the field has no state for it in its fold. The
 * client store leaves such a column alone (`RecordFolder.materializeRow` writes only the
 * fields the fold holds), so it keeps the value the column was created or added with:
 * the schema default. The server stores wrote `values[field] ?? null` for every schema
 * field. So a v1 todo reads `status: 'open'` on every device and `status: null` on the
 * server: server-side queries disagree with the devices, and a scope such as
 * `{ status: 'open' }` (which falls back to the current row for a field the scope
 * snapshot does not hold, RT-20) never delivers those records to a new device.
 *
 * Asserts the CORRECT behaviour: a field the fold never wrote materializes as its
 * schema default on the server too, after a restart on the new schema and on a fresh
 * server that only ever ran the new schema.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HybridLogicalClock, createOperation, defineSchema, t } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { afterAll, describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createPostgresServerStore } from '../../src/store/postgres-server-store'
import type { ServerStore } from '../../src/store/server-store'
import { createSqliteServerStore } from '../../src/store/sqlite-server-store'

const v1 = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
}) as unknown as SchemaDefinition
const v2 = defineSchema({
	version: 2,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				status: t.string().default('open'),
				due: t.timestamp().optional(),
			},
		},
	},
}) as unknown as SchemaDefinition

const dir = mkdtempSync(join(tmpdir(), 'rt-106-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function v1Insert(): Promise<Operation> {
	return createOperation(
		{
			nodeId: 'device-a',
			type: 'insert',
			collection: 'todos',
			recordId: 't1',
			data: { title: 'written under v1' },
			previousData: null,
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		},
		new HybridLogicalClock('device-a'),
	)
}

async function rowOf(store: ServerStore): Promise<Record<string, unknown> | undefined> {
	const rows = (await store.queryCollection('todos', {})) as Array<Record<string, unknown>>
	return rows.find((row) => row.id === 't1')
}

const expected = { id: 't1', title: 'written under v1', status: 'open', due: null }
const pick = (row: Record<string, unknown> | undefined) => ({
	id: row?.id,
	title: row?.title,
	status: row?.status,
	due: row?.due ?? null,
})

describe('RT-106: a field added with a default materializes as the default on the server', () => {
	test('memory store: v1 record read under v2', async () => {
		const store = new MemoryServerStore()
		await store.setSchema(v1)
		await store.applyRemoteOperation(await v1Insert())
		await store.setSchema(v2)
		expect(pick(await rowOf(store))).toEqual(expected)
		await store.close()
	})

	test('SQLite store: restart on v2, and a fresh v2 server', async () => {
		const filename = join(dir, 'upgrade.db')
		const first = createSqliteServerStore({ filename })
		await first.setSchema(v1)
		await first.applyRemoteOperation(await v1Insert())
		await first.close()
		const upgraded = createSqliteServerStore({ filename })
		await upgraded.setSchema(v2)
		expect(pick(await rowOf(upgraded))).toEqual(expected)
		await upgraded.close()

		const fresh = createSqliteServerStore({ filename: join(dir, 'fresh.db') })
		await fresh.setSchema(v2)
		await fresh.applyRemoteOperation(await v1Insert())
		expect(pick(await rowOf(fresh))).toEqual(expected)
		await fresh.close()
	})

	const pgUrl = process.env.KORA_PG_TEST_URL
	test.skipIf(!pgUrl)('Postgres store: restart on v2', async () => {
		const { default: postgres } = await import('postgres')
		const admin = postgres(pgUrl ?? '', { max: 1, onnotice: () => {} })
		await admin.unsafe('DROP DATABASE IF EXISTS kora_rt106')
		await admin.unsafe('CREATE DATABASE kora_rt106')
		await admin.end()
		const url = (pgUrl ?? '').replace(/\/[^/]*$/, '/kora_rt106')
		const first = await createPostgresServerStore({ connectionString: url })
		await first.setSchema(v1)
		await first.applyRemoteOperation(await v1Insert())
		await first.close()
		const upgraded = await createPostgresServerStore({ connectionString: url })
		try {
			await upgraded.setSchema(v2)
			expect(pick(await rowOf(upgraded))).toEqual(expected)
		} finally {
			await upgraded.close()
		}
	})
})
