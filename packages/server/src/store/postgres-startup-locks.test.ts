import { defineSchema, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { dropTrackedPgSchemas, trackPgSchema } from '../../tests/fixtures/pg-test-schemas'
import { PostgresServerStore } from './postgres-server-store'

/**
 * An instance starting (`setSchema`) against a database other instances are serving
 * from must not take table locks that live writes need while it waits for one of them.
 * Every append updates the delivery counter row first and then writes the operation
 * log; a starting instance seeds that counter row in its setup transaction. If the setup
 * transaction already holds a lock on `operations` (an `ALTER TABLE ... ADD COLUMN IF
 * NOT EXISTS` takes ACCESS EXCLUSIVE even when the column exists, a `CREATE INDEX IF NOT
 * EXISTS` takes SHARE), the in-flight append waits for it while it waits for the
 * append: a deadlock, which Postgres resolves by aborting one of them. Set
 * KORA_PG_TEST_URL to run.
 */
const PG_URL = process.env.KORA_PG_TEST_URL

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string() } } },
})

/** The Postgres error code and message of a (possibly Drizzle-wrapped) error, or null. */
function describeError(error: unknown): string | null {
	if (error === null || error === undefined) return null
	const cause = (error as { cause?: unknown }).cause
	const inner = (cause ?? error) as { code?: string; message?: string }
	return `${inner.code ?? 'error'}: ${inner.message ?? String(error)}`
}

describe.skipIf(!PG_URL)('Postgres instance start during live writes', () => {
	const name = `kora_startlock_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
	const clients: ReturnType<typeof postgres>[] = []
	const connect = (max: number): ReturnType<typeof postgres> => {
		const client = postgres(PG_URL as string, {
			max,
			onnotice: () => {},
			connection: { search_path: name, application_name: name },
		})
		clients.push(client)
		return client
	}

	beforeAll(async () => {
		const admin = postgres(PG_URL as string, { max: 1, onnotice: () => {} })
		await admin.unsafe(`CREATE SCHEMA ${name}`)
		trackPgSchema(name)
		await admin.end()
	})

	afterAll(async () => {
		await Promise.all(clients.splice(0).map((client) => client.end()))
		await dropTrackedPgSchemas()
	})

	test('a starting instance never deadlocks with an append in flight', async () => {
		const running = new PostgresServerStore(drizzle(connect(2)), 'server-a')
		await running.setSchema(schema)

		// An append in flight on the running instance, held open between its two steps:
		// it holds the delivery counter row and has yet to write the operation log.
		const live = connect(1)
		const reserved = await live.reserve()
		await reserved.unsafe('BEGIN')
		await reserved.unsafe('UPDATE delivery_counter SET value = value + 1 WHERE id = 1')

		// A second instance starts against the same database meanwhile.
		const starting = new PostgresServerStore(drizzle(connect(2)), 'server-b')
		const started = starting.setSchema(schema).then(
			() => null,
			(error: unknown) => error,
		)
		// Wait (on the condition, not a delay) until its setup blocks behind the append.
		const observer = connect(1)
		await vi.waitFor(
			async () => {
				const [row] = await observer.unsafe(
					`SELECT count(*)::int AS n FROM pg_stat_activity
					 WHERE application_name = $1 AND wait_event_type = 'Lock' AND pid <> $2`,
					[name, (await reserved.unsafe('SELECT pg_backend_pid() AS pid'))[0]?.pid],
				)
				expect(row?.n).toBe(1)
			},
			{ timeout: 20_000, interval: 20 },
		)

		// The append goes on: it reads and writes the operation log, then commits.
		let appendError: unknown = null
		try {
			await reserved.unsafe('SELECT count(*) FROM operations')
			// The lock its INSERT into the log takes.
			await reserved.unsafe('LOCK TABLE operations IN ROW EXCLUSIVE MODE')
			await reserved.unsafe('COMMIT')
		} catch (error) {
			appendError = error
			await reserved.unsafe('ROLLBACK').catch(() => {})
		}
		reserved.release()
		const startError = await started

		// Postgres aborts one side of a deadlock (40P01); neither may fail.
		expect(describeError(appendError)).toBeNull()
		expect(describeError(startError)).toBeNull()
		await starting.close()
		await running.close()
	})
})
