/**
 * The record an access rule judges as the write's result (`previewResult`) is the row the
 * store persists, field for field. A record whose operations predate a defaulted field
 * has no fold state for it: the store materializes that column with the schema default
 * (RT-106), so the preview must hold the default too, or an update rule on that field
 * sees `undefined` and refuses a write whose stored row still satisfies it.
 * Postgres runs with KORA_PG_TEST_URL.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HybridLogicalClock, createOperation, defineSchema, t } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { PostgresServerStore } from '../../src/store/postgres-server-store'
import type { ServerStore } from '../../src/store/server-store'
import { createSqliteServerStore } from '../../src/store/sqlite-server-store'
import { dropTrackedPgSchemas, trackPgSchema } from '../fixtures/pg-test-schemas'

// Before the hooks that end this file's clients: afterAll hooks run in reverse order.
afterAll(dropTrackedPgSchemas)

/** v2 added `visibility` (default 'private') and `tags` (default []) after v1 records. */
const v2 = defineSchema({
	version: 2,
	collections: {
		notes: {
			fields: {
				title: t.string(),
				count: t.number().default(0),
				visibility: t.string().default('private'),
				tags: t.array(t.string()).default([]),
			},
		},
	},
}) as unknown as SchemaDefinition

const dir = mkdtempSync(join(tmpdir(), 'kora-preview-defaults-'))
const PG_URL = process.env.KORA_PG_TEST_URL
const clients: ReturnType<typeof postgres>[] = []
afterAll(async () => {
	await Promise.all(clients.map((client) => client.end()))
	rmSync(dir, { recursive: true, force: true })
})

async function operations(): Promise<[Operation, Operation]> {
	const clock = new HybridLogicalClock('device-a')
	const insert = await createOperation(
		{
			nodeId: 'device-a',
			type: 'insert',
			collection: 'notes',
			recordId: 'n1',
			data: { title: 'written under v1', count: 0 },
			previousData: null,
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		},
		clock,
	)
	const increment = await createOperation(
		{
			nodeId: 'device-a',
			type: 'update',
			collection: 'notes',
			recordId: 'n1',
			data: { count: 1 },
			previousData: { count: 0 },
			atomicOps: { count: { type: 'increment', value: 1 } },
			sequenceNumber: 2,
			causalDeps: [insert.id],
			schemaVersion: 2,
		},
		clock,
	)
	return [insert, increment]
}

async function check(store: ServerStore): Promise<void> {
	await store.setSchema(v2)
	const [insert, increment] = await operations()
	await store.applyRemoteOperation(insert)
	let judged: { stored: unknown; resulting: unknown } | null = null
	// As `custom(({ record }) => record.visibility === 'private')` on update would.
	await store.applyRemoteOperation(increment, {
		previewResult: true,
		authorize: (stored, context) => {
			const resulting = context.resulting?.values ?? {}
			judged = {
				stored: { visibility: stored?.visibility, tags: stored?.tags },
				resulting: {
					visibility: resulting.visibility,
					tags: resulting.tags,
					count: resulting.count,
				},
			}
			return resulting.visibility === 'private'
				? { allowed: true }
				: { allowed: false, code: 'ACCESS_DENIED', message: 'not private' }
		},
	})
	expect(judged).toEqual({
		stored: { visibility: 'private', tags: [] },
		resulting: { visibility: 'private', tags: [], count: 1 },
	})
	const row = (await store.findRecord('notes', 'n1')) as Record<string, unknown> | null
	expect({ visibility: row?.visibility, tags: row?.tags, count: row?.count }).toEqual({
		visibility: 'private',
		tags: [],
		count: 1,
	})
}

describe('the authorization preview holds the defaults the store materializes', () => {
	test('memory', async () => {
		const store = new MemoryServerStore()
		try {
			await check(store)
		} finally {
			await store.close()
		}
	})

	test('sqlite', async () => {
		const store = createSqliteServerStore({ filename: join(dir, 'server.db') })
		try {
			await check(store)
		} finally {
			await store.close()
		}
	})

	test.skipIf(!PG_URL)('postgres', async () => {
		const name = `kora_preview_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
		const admin = postgres(PG_URL ?? '', { max: 1 })
		await admin.unsafe(`CREATE SCHEMA ${name}`)
		trackPgSchema(name)
		await admin.end()
		const client = postgres(PG_URL ?? '', { max: 4, connection: { search_path: name } })
		clients.push(client)
		await check(new PostgresServerStore(drizzle(client), 'server-node'))
	})
})
