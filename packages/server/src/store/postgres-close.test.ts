import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { describe, expect, test } from 'vitest'
import { createPostgresServerStore } from './postgres-server-store'

const PG_URL = process.env.KORA_PG_TEST_URL

describe.skipIf(!PG_URL)('postgres: close() (KORA_PG_TEST_URL)', () => {
	test('a store created from a connection string ends its own client', async () => {
		const url = new URL(PG_URL ?? '')
		const applicationName = `kora-close-${randomUUID()}`
		url.searchParams.set('application_name', applicationName)
		const admin = postgres(PG_URL ?? '', { max: 1, onnotice: () => {} })
		const connections = async (): Promise<number> => {
			const rows = await admin<{ n: number }[]>`
				SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = ${applicationName}`
			return rows[0]?.n ?? 0
		}
		try {
			const store = await createPostgresServerStore({ connectionString: url.toString() })
			expect(await connections()).toBeGreaterThan(0)
			await store.close()
			expect(await connections()).toBe(0)
		} finally {
			await admin.end({ timeout: 0 })
		}
	})
})
