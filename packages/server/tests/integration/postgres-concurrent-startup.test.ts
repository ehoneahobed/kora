/**
 * Two instances starting together on one Postgres database (an overlapping deploy) must not
 * run schema setup at the same time: their bulk statements lock fold-state and operation rows
 * in different orders, and one instance died with `deadlock detected`. Setup is serialized
 * with an advisory lock; the test holds the first instance inside its setup and checks the
 * second waits, with no sleeps (it polls `pg_locks` for the waiting lock request).
 */
import { defineSchema, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { describe, expect, test, vi } from 'vitest'
import { PostgresServerStore } from '../../src/store/postgres-server-store'

const PG_URL = process.env.KORA_PG_TEST_URL
const SETUP_LOCK = "hashtextextended('kora:schema-setup', 0)"

const schemaV1 = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string() } } },
})
const schemaV2 = defineSchema({
	version: 2,
	collections: { notes: { fields: { title: t.string(), body: t.string().optional() } } },
})

describe.skipIf(!PG_URL)('concurrent startup on one Postgres database', () => {
	test('the second instance waits for the first one to finish its schema setup', async () => {
		const url = PG_URL as string
		const name = `kora_start_${process.pid}_${Math.floor(Math.random() * 1e9)}`
		const admin = postgres(url, { max: 1 })
		await admin.unsafe(`CREATE SCHEMA ${name}`)
		const open = () => {
			const client = postgres(url, { max: 4, connection: { search_path: name } })
			return { client, store: new PostgresServerStore(drizzle(client), 's') }
		}
		const a = open()
		const b = open()
		try {
			// A database restored from the previous schema version.
			await a.store.setSchema(schemaV1)

			const entered: string[] = []
			let releaseA: () => void = () => {}
			const heldA = new Promise<void>((resolve) => {
				releaseA = resolve
			})
			a.store.schemaSetupHooks.afterLock = async () => {
				entered.push('a')
				await heldA
			}
			b.store.schemaSetupHooks.afterLock = async () => {
				entered.push('b')
			}

			const setupA = a.store.setSchema(schemaV2)
			await vi.waitFor(() => expect(entered).toEqual(['a']))
			const setupB = b.store.setSchema(schemaV2)

			// B is queued behind A's lock: a lock request of this key that is not granted.
			await vi.waitFor(async () => {
				const waiting = await admin.unsafe(
					`SELECT count(*)::int AS n FROM pg_locks l
					 WHERE l.locktype = 'advisory' AND NOT l.granted
					   AND ((l.classid::bigint << 32) | l.objid::bigint) = ${SETUP_LOCK}`,
				)
				expect(waiting[0]?.n).toBe(1)
			})
			expect(entered).toEqual(['a'])

			releaseA()
			await Promise.all([setupA, setupB])
			expect(entered).toEqual(['a', 'b'])

			// Both instances now serve the upgraded schema.
			const columns = await admin.unsafe(
				`SELECT column_name FROM information_schema.columns
				 WHERE table_schema = '${name}' AND table_name = 'notes' AND column_name = 'body'`,
			)
			expect(columns).toHaveLength(1)
		} finally {
			a.store.schemaSetupHooks.afterLock = undefined
			await a.store.close().catch(() => {})
			await b.store.close().catch(() => {})
			await a.client.end()
			await b.client.end()
			await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
			await admin.end()
		}
	})
})
