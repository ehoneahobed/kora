/**
 * RT-87 repro (Phase 3 red team round 4, 2026-10-03): a `t.timestamp()` value the API
 * accepts (any finite number) does not fit the Postgres server store's BIGINT column.
 *
 * `validateFieldValue` accepts any finite number for a timestamp. The Postgres store
 * materializes timestamps as BIGINT:
 * - a fractional value (`performance.timeOrigin + performance.now()`, `Date.now() / 1e3`)
 *   fails with SQLSTATE 22P02, mapped to UNSTORABLE_VALUE: the server refuses the insert
 *   terminally and the record vanishes from the writing device;
 * - a value beyond the BIGINT range (`1e20`) fails with SQLSTATE 22003, which is not
 *   mapped: the batch fails, the device re-sends it every session, and no later write of
 *   that device reaches a peer.
 * Memory and SQLite server stores, and every client store, hold both values. Not a
 * round-4 regression.
 *
 * Asserts the CORRECT behaviour (fails at 5498764 with KORA_PG_TEST_URL): either the API
 * refuses the value up front, or every replica (Postgres server included) holds it; the
 * device's next ordinary write reaches the peer.
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
		notes: { fields: { title: t.string(), due: t.timestamp().optional() } },
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
const clients: PgClient[] = []

async function pgStore(): Promise<PostgresServerStore> {
	const postgres = serverRequire('postgres') as (url: string, o?: object) => PgClient
	const { drizzle } = serverRequire('drizzle-orm/postgres-js') as {
		drizzle: (client: PgClient) => ConstructorParameters<typeof PostgresServerStore>[0]
	}
	const name = `kora_rt87_${process.pid}_${schemas.length}`
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
	clients.push(client)
	return new PostgresServerStore(drizzle(client), 'server-pg')
}

afterAll(async () => {
	if (!PG_URL) return
	for (const client of clients) await client.end().catch(() => {})
	const postgres = serverRequire('postgres') as (url: string, o?: object) => PgClient
	const admin = postgres(PG_URL, { onnotice: () => {} })
	for (const name of schemas) await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
	await admin.end()
})

describe.skipIf(!PG_URL).each([
	['fractional', 1_791_000_000_000.5],
	['beyond BIGINT', 1e20],
])('RT-87: a %s timestamp through the Postgres store', (_name, due) => {
	test('the record and the next write reach the peer', async () => {
		const network = await createTestNetwork(schema, { devices: 2, serverStore: await pgStore() })
		try {
			const [a, b] = network.devices as [TestDevice, TestDevice]
			let threw = false
			try {
				await a.collection('notes').insert({ title: 'odd', due })
			} catch {
				// Refusing the value up front is a correct outcome.
				threw = true
			}
			await a.collection('notes').insert({ title: 'next' })
			for (let i = 0; i < 3; i++) {
				await a.reconnect().catch(() => {})
				await a.sync().catch(() => {})
				await b.sync().catch(() => {})
			}
			const onA = (await a.getState('notes')).map((r) => r.title).sort()
			const onB = (await b.getState('notes')).map((r) => r.title).sort()
			// Fails: the fractional insert vanishes from A (UNSTORABLE_VALUE); 1e20 wedges A.
			expect(onA).toEqual(threw ? ['next'] : ['next', 'odd'])
			expect(onB).toEqual(onA)
		} finally {
			await network.close()
		}
	}, 60_000)
})
