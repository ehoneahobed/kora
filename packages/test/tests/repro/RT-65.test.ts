/**
 * RT-65 repro (Phase 3 red team, 2026-10-02): the Postgres server store cannot store a
 * string containing U+0000 or a lone UTF-16 surrogate. Both are valid JavaScript
 * strings that every client store (SQLite, IndexedDB) and the memory and SQLite server
 * stores keep, and both arrive from ordinary user input (pasted text, a truncated
 * emoji). Postgres TEXT refuses NUL, and the materialized JSONB columns (arrays,
 * objects, json) refuse both `\u0000` and an unpaired surrogate escape. The apply
 * throws, the server answers with a retriable failure, and the device re-sends the
 * same operation forever: the operation never reaches any peer, and every later
 * write of that device queues behind it.
 *
 * Asserts the CORRECT behaviour (fails at 959b791 with KORA_PG_TEST_URL): both the
 * poisoned write and a later ordinary write reach the peer.
 */
import { createRequire } from 'node:module'
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { PostgresServerStore } from '@korajs/server'
import { afterAll, describe, expect, test } from 'vitest'
import { type TestDevice, createTestNetwork } from '../../src/index'

const PG_URL = process.env.KORA_PG_TEST_URL
const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { title: t.string(), tags: t.array(t.string()).default([]) } },
	},
}) as unknown as SchemaDefinition

interface PgClient {
	unsafe: (sql: string) => Promise<unknown>
	end: () => Promise<void>
}
const serverRequire = createRequire(
	createRequire(import.meta.url).resolve('@korajs/server/package.json'),
)
const schemas: string[] = []

async function pgStore(): Promise<PostgresServerStore> {
	const postgres = serverRequire('postgres') as (url: string, o?: object) => PgClient
	const { drizzle } = serverRequire('drizzle-orm/postgres-js') as {
		drizzle: (client: PgClient) => ConstructorParameters<typeof PostgresServerStore>[0]
	}
	const name = `kora_rt65_${process.pid}_${schemas.length}`
	const admin = postgres(PG_URL as string, { onnotice: () => {} })
	await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
	await admin.unsafe(`CREATE SCHEMA ${name}`)
	await admin.end()
	schemas.push(name)
	const client = postgres(PG_URL as string, {
		max: 4,
		onnotice: () => {},
		connection: { search_path: name },
	})
	return new PostgresServerStore(drizzle(client), 'server-pg')
}

afterAll(async () => {
	if (!PG_URL) return
	const postgres = serverRequire('postgres') as (url: string, o?: object) => PgClient
	const admin = postgres(PG_URL, { onnotice: () => {} })
	for (const name of schemas) await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
	await admin.end()
})

describe.skipIf(!PG_URL).each([
	['a NUL character in a string field', { title: 'pasted\u0000text' }],
	['a lone surrogate in a string field', { title: 'cut emoji \ud83d' }],
	['a NUL character in an array element', { title: 'ok', tags: ['a\u0000b'] }],
])('RT-65: %s through the Postgres store', (_name, poisoned) => {
	test('the write and every later write of the device reach the peer', async () => {
		const network = await createTestNetwork(schema, { devices: 2, serverStore: await pgStore() })
		try {
			const [a, b] = network.devices as [TestDevice, TestDevice]
			await a.sync()
			await b.sync()
			const first = await a.collection('notes').insert(poisoned)
			const later = await a.collection('notes').insert({ title: 'ordinary' })
			for (let i = 0; i < 3; i++) {
				await a.sync()
				await b.sync()
			}
			expect(await b.collection('notes').findById(String(later.id))).toMatchObject({
				title: 'ordinary',
			})
			expect(await b.collection('notes').findById(String(first.id))).toMatchObject(poisoned)
		} finally {
			await network.close()
		}
	}, 60_000)
})
