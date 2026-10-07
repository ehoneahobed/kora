import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { PostgresUserStore } from './postgres-user-store'

type Client = ConstructorParameters<typeof PostgresUserStore>[0]

/** A client stub that answers every query with no rows. */
function stubClient(): Client & { end: ReturnType<typeof vi.fn> } {
	const sql = (async () => []) as unknown as Client & { end: ReturnType<typeof vi.fn> }
	Object.assign(sql, {
		begin: async (fn: (tx: Client) => Promise<unknown>) => fn(sql),
		end: vi.fn(async () => {}),
	})
	return sql
}

const PG_URL = process.env.KORA_PG_TEST_URL
const require = createRequire(import.meta.url)

describe('PostgresUserStore.close (F11)', () => {
	it('ends a client the store owns, once', async () => {
		const sql = stubClient()
		const store = new PostgresUserStore(sql, { ownsClient: true })
		await store.close()
		await store.close()
		expect(sql.end).toHaveBeenCalledTimes(1)
	})

	it("leaves a caller's client open", async () => {
		const sql = stubClient()
		const store = new PostgresUserStore(sql)
		await store.findByEmail('nobody@example.com')
		await store.close()
		expect(sql.end).not.toHaveBeenCalled()
	})

	it.skipIf(!PG_URL)('releases the connections of a store that owns its client', async () => {
		// What createPostgresUserStore builds (its dynamic import does not run under Vitest).
		const postgres = require('postgres') as (url: string) => Client
		const store = new PostgresUserStore(postgres(PG_URL as string), { ownsClient: true })
		expect(await store.findByEmail('nobody@example.com')).toBeNull()
		await store.close()
		await expect(store.findByEmail('nobody@example.com')).rejects.toThrow()
	})
})
