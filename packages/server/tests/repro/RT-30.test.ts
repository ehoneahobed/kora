/**
 * RT-30: the live-Postgres parity tests could not run under vitest. The Postgres driver
 * was loaded through `new Function('return import(specifier)')`, which escapes vitest's
 * module runner (no dynamic-import callback in its VM context), so createPostgresServerStore
 * threw "requires the postgres package" even with `postgres` installed. The parity suite
 * also keyed off DATABASE_URL (unlike every other Postgres test, KORA_PG_TEST_URL) and
 * reused one schema, so a second run found the first run's rows.
 *
 * Needs no database: postgres.js connects lazily, so loading the driver and building the
 * store must succeed against an address nothing listens on.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
	PostgresServerStore,
	createPostgresServerStore,
} from '../../src/store/postgres-server-store'

describe('RT-30: Postgres tests run under vitest', () => {
	test('createPostgresServerStore loads the postgres driver inside the vitest runner', async () => {
		const store = await createPostgresServerStore({
			connectionString: 'postgres://kora:kora@127.0.0.1:1/kora_rt30',
			nodeId: 'rt30',
		})
		expect(store).toBeInstanceOf(PostgresServerStore)
		// The driver is live: the first query reaches the network (and nothing listens there).
		await expect(store.getOperationCount()).rejects.toMatchObject({ code: 'ECONNREFUSED' })
		await store.close().catch(() => {})
	})

	test('the parity suite runs on KORA_PG_TEST_URL, one fresh schema per store', () => {
		const source = readFileSync(
			join(__dirname, '../integration/server-store-parity.test.ts'),
			'utf8',
		)
		expect(source).toContain('process.env.KORA_PG_TEST_URL')
		expect(source).toMatch(/CREATE SCHEMA/)
		expect(source).toMatch(/search_path/)
	})
})
