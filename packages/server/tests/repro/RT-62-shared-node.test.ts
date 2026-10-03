/**
 * RT-62 repro, second half (Phase 3 red team, 2026-10-02): the only configuration that
 * would give several server instances ONE authoritative node id (the same configured
 * `nodeId` on every instance over one Postgres database) makes the instances collide
 * on the server node's sequence numbers: each instance caches its own counter
 * (`reserveSequenceNumber` starts from its own view of the version vector), so the
 * second instance's route writes (and side effects, corrections) are refused with
 * SEQUENCE_CONFLICT. With distinct (auto-generated) ids the instances advertise
 * different authoritative sets instead (RT-62.test.ts in @korajs/test).
 *
 * Asserts the CORRECT behaviour (fails at 959b791 with KORA_PG_TEST_URL).
 */
import { defineSchema, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { describe, expect, test } from 'vitest'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { PostgresServerStore } from '../../src/store/postgres-server-store'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string() } } },
})
const url = process.env.KORA_PG_TEST_URL as string

describe.skipIf(!url)('RT-62: two instances sharing one configured node id', () => {
	test('route writes on both instances succeed', async () => {
		const name = `rt3_shared_${Date.now()}`
		const admin = postgres(url, { max: 1, onnotice: () => {} })
		await admin.unsafe(`CREATE SCHEMA ${name}`)
		await admin.end()
		const mk = () =>
			new PostgresServerStore(
				drizzle(postgres(url, { max: 4, onnotice: () => {}, connection: { search_path: name } })),
				'server-shared',
			)
		const s1 = mk()
		await s1.setSchema(schema)
		const s2 = mk()
		await s2.setSchema(schema)
		const k1 = new KoraSyncServer({
			store: s1,
			relayRetransmitIntervalMs: 0,
			deliveryPollIntervalMs: 0,
		})
		const k2 = new KoraSyncServer({
			store: s2,
			relayRetransmitIntervalMs: 0,
			deliveryPollIntervalMs: 0,
		})
		const results: unknown[] = []
		for (let i = 0; i < 3; i++) {
			results.push(
				await k1
					.getKoraContext()
					.apply({ collection: 'notes', type: 'insert', data: { title: `a${i}` } })
					.catch((e) => ({ ok: false, e: String(e) })),
			)
			results.push(
				await k2
					.getKoraContext()
					.apply({ collection: 'notes', type: 'insert', data: { title: `b${i}` } })
					.catch((e) => ({ ok: false, e: String(e) })),
			)
		}
		expect(results.every((r) => (r as { ok?: boolean }).ok === true)).toBe(true)
		await k1.stop()
		await k2.stop()
	})
})
