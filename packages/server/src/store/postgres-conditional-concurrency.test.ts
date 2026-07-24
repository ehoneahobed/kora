import { type SchemaDefinition, type TimeSource, defineSchema, op, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { KoraSyncServer } from '../server/kora-sync-server'
import { createRouteContext } from '../server/route-context'
import { PostgresServerStore } from './postgres-server-store'

/**
 * Real-Postgres proof that cross-instance conditional apply is race-free: many
 * concurrent admissions to a capped form, spread across several server instances
 * sharing one database, admit EXACTLY the cap. Requires a running Postgres; set
 * KORA_PG_TEST_URL to enable (for example
 * `postgres://postgres@localhost:5433/postgres`). Skipped otherwise so the normal
 * unit suite stays hermetic.
 */
const PG_URL = process.env.KORA_PG_TEST_URL

const schema: SchemaDefinition = defineSchema({
	version: 1,
	collections: {
		forms: {
			fields: {
				status: t.string(),
				responseCount: t.number(),
				maxResponses: t.number(),
			},
		},
		responses: {
			fields: {
				formId: t.string(),
				answer: t.string(),
			},
		},
	},
})

interface Instance {
	client: ReturnType<typeof postgres>
	store: PostgresServerStore
	ctx: ReturnType<typeof createRouteContext>
}

describe.skipIf(!PG_URL)('cross-instance conditional apply on Postgres', () => {
	let admin: ReturnType<typeof postgres>
	const instances: Instance[] = []

	// Isolate this file's tables in a dedicated schema so it can run in parallel with
	// other Postgres test files that also drop and recreate the same table names on the
	// shared database. Every instance in this file shares the one schema on purpose:
	// the test exercises multiple server instances against one database.
	const PG_SCHEMA = 'kora_test_conditional'

	function makeInstance(nodeId: string, timeSource?: TimeSource): Instance {
		const client = postgres(PG_URL as string, { max: 6, connection: { search_path: PG_SCHEMA } })
		const store = new PostgresServerStore(drizzle(client), nodeId, timeSource)
		const server = new KoraSyncServer({ store })
		const ctx = createRouteContext(server, store)
		instances.push({ client, store, ctx })
		return instances[instances.length - 1] as Instance
	}

	beforeAll(async () => {
		admin = postgres(PG_URL as string, { max: 1, connection: { search_path: PG_SCHEMA } })
		await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}`)
	})

	afterAll(async () => {
		for (const inst of instances) {
			await inst.store.close()
			await inst.client.end()
		}
		await admin.end()
	})

	beforeEach(async () => {
		// Drop every table so each test starts from a clean database.
		await admin.unsafe('DROP TABLE IF EXISTS forms, responses, operations, sync_state CASCADE')
		instances.length = 0
	})

	test('admits exactly the cap across concurrent admissions on three instances', async () => {
		const cap = 5
		const attempts = 40

		// One instance provisions the schema and seeds the form; the others attach to
		// the same tables.
		const seeder = makeInstance('server-a')
		await seeder.store.setSchema(schema)
		const seeded = await seeder.ctx.apply({
			collection: 'forms',
			type: 'insert',
			recordId: 'form-1',
			data: { status: 'published', responseCount: 0, maxResponses: cap },
		})
		expect(seeded.ok).toBe(true)

		const b = makeInstance('server-b')
		const c = makeInstance('server-c')
		await b.store.setSchema(schema)
		await c.store.setSchema(schema)
		const ring = [seeder, b, c]

		// Fire every admission at once, round-robin across the three instances. Each is
		// a full conditional apply: admit while responseCount < cap, increment the
		// counter, and insert the response, at-most-once per response id.
		const results = await Promise.all(
			Array.from({ length: attempts }, (_, i) => {
				const inst = ring[i % ring.length] as Instance
				return inst.ctx.applyConditional({
					collection: 'forms',
					id: 'form-1',
					if: { status: { $eq: 'published' }, responseCount: { $lt: cap } },
					update: { responseCount: op.increment(1) },
					also: [
						{
							collection: 'responses',
							type: 'insert',
							recordId: `resp-${i}`,
							data: { formId: 'form-1', answer: `answer-${i}` },
						},
					],
					reject: { code: 'max_responses_reached', message: 'This form is full.' },
					idempotencyKey: { collection: 'responses', id: `resp-${i}` },
				})
			}),
		)

		const admitted = results.filter((r) => r.ok && !r.idempotent)
		const rejected = results.filter((r) => !r.ok)
		expect(admitted.length).toBe(cap)
		expect(rejected.length).toBe(attempts - cap)
		for (const r of rejected) {
			if (!r.ok) {
				expect(r.code).toBe('max_responses_reached')
			}
		}

		// The materialized counter equals the cap, and exactly `cap` response records
		// exist. This is the real proof: even with same-millisecond commits on distinct
		// instances, the advisory lock plus the clock advanced past the target's latest
		// write keep last-write-wins materialization from undercounting.
		const form = await seeder.store.findRecord('forms', 'form-1')
		expect(form?.responseCount).toBe(cap)
		expect(await seeder.store.countCollection('responses')).toBe(cap)
	})

	test('admits exactly the cap even when every commit shares one wall-clock instant', async () => {
		// Freeze wall time to the SAME instant across all instances. Now HLC wallTime
		// can never separate two commits: ordering falls entirely to the logical
		// counter, which is only advanced correctly because applyConditional seeds its
		// clock past the target's latest write. This is the case a real same-millisecond
		// burst hits rarely; freezing time makes it certain and the test deterministic.
		const frozen: TimeSource = { now: () => 1_000_000_000_000 }
		const cap = 5
		const attempts = 40

		const seeder = makeInstance('server-a', frozen)
		await seeder.store.setSchema(schema)
		const seeded = await seeder.ctx.apply({
			collection: 'forms',
			type: 'insert',
			recordId: 'form-frozen',
			data: { status: 'published', responseCount: 0, maxResponses: cap },
		})
		expect(seeded.ok).toBe(true)

		const b = makeInstance('server-b', frozen)
		const c = makeInstance('server-c', frozen)
		await b.store.setSchema(schema)
		await c.store.setSchema(schema)
		const ring = [seeder, b, c]

		const results = await Promise.all(
			Array.from({ length: attempts }, (_, i) => {
				const inst = ring[i % ring.length] as Instance
				return inst.ctx.applyConditional({
					collection: 'forms',
					id: 'form-frozen',
					if: { status: { $eq: 'published' }, responseCount: { $lt: cap } },
					update: { responseCount: op.increment(1) },
					also: [
						{
							collection: 'responses',
							type: 'insert',
							recordId: `frz-${i}`,
							data: { formId: 'form-frozen', answer: `answer-${i}` },
						},
					],
					reject: { code: 'max_responses_reached', message: 'This form is full.' },
					idempotencyKey: { collection: 'responses', id: `frz-${i}` },
				})
			}),
		)

		const admitted = results.filter((r) => r.ok && !r.idempotent)
		expect(admitted.length).toBe(cap)
		const form = await seeder.store.findRecord('forms', 'form-frozen')
		expect(form?.responseCount).toBe(cap)
		expect(await seeder.store.countCollection('responses')).toBe(cap)
	})

	test('idempotent retry never double-admits, even racing itself across instances', async () => {
		const cap = 10
		const seeder = makeInstance('server-a')
		await seeder.store.setSchema(schema)
		await seeder.ctx.apply({
			collection: 'forms',
			type: 'insert',
			recordId: 'form-2',
			data: { status: 'published', responseCount: 0, maxResponses: cap },
		})
		const b = makeInstance('server-b')
		await b.store.setSchema(schema)

		// The same response id submitted many times concurrently across two instances
		// must increment the counter exactly once.
		const submit = (inst: Instance): Promise<unknown> =>
			inst.ctx.applyConditional({
				collection: 'forms',
				id: 'form-2',
				if: { responseCount: { $lt: cap } },
				update: { responseCount: op.increment(1) },
				also: [
					{
						collection: 'responses',
						type: 'insert',
						recordId: 'resp-dup',
						data: { formId: 'form-2', answer: 'a' },
					},
				],
				idempotencyKey: { collection: 'responses', id: 'resp-dup' },
			})

		await Promise.all(Array.from({ length: 12 }, (_, i) => submit(i % 2 === 0 ? seeder : b)))

		const form = await seeder.store.findRecord('forms', 'form-2')
		expect(form?.responseCount).toBe(1)
		expect(await seeder.store.countCollection('responses')).toBe(1)
	})
})
