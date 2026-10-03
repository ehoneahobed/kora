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
 *
 * Adapted to the beta.14 design (RT-62 fix): the configured id is a legacy server id;
 * each instance authors under its own `kora:server:<deployment>:<instance>` id (one
 * deployment persisted in the database, a distinct instance per process), so route
 * writes on both instances succeed, both are server-authoritative, and a device's
 * later write of a `merge('server-authoritative')` field does not override them.
 */
import { defineSchema, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { describe, expect, test } from 'vitest'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { PostgresServerStore } from '../../src/store/postgres-server-store'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: {
			fields: { title: t.string(), status: t.string().merge('server-authoritative').optional() },
		},
	},
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

		// One deployment, two distinct instance node ids, both authoritative.
		const n1 = s1.getNodeId()
		const n2 = s2.getNodeId()
		expect(n1).not.toBe(n2)
		expect(n1.startsWith('kora:server:')).toBe(true)
		expect(n1.split(':')[2]).toBe(n2.split(':')[2])
		expect(s2.getAuthoritativeNodeIds()).toContain('server-shared')

		// Server-authoritative decisions from both instances beat a later device write.
		const inserted = (await k1
			.getKoraContext()
			.apply({ collection: 'notes', type: 'insert', data: { title: 'x', status: 'draft' } })) as {
			ok: boolean
			operation?: { recordId: string }
		}
		expect(inserted.ok).toBe(true)
		const recordId = inserted.operation?.recordId as string
		expect(
			(
				await k2.getKoraContext().apply({
					collection: 'notes',
					type: 'update',
					recordId,
					data: { status: 'approved' },
				})
			).ok,
		).toBe(true)
		await s1.applyRemoteOperation({
			id: 'rt62-device-write',
			nodeId: 'device-1',
			type: 'update',
			collection: 'notes',
			recordId,
			data: { status: 'client' },
			previousData: { status: 'approved' },
			timestamp: { wallTime: Date.now() + 60_000, logical: 0, nodeId: 'device-1' },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		})
		expect(await s1.findRecord('notes', recordId)).toMatchObject({ status: 'approved' })
		expect(await s2.findRecord('notes', recordId)).toMatchObject({ status: 'approved' })
		await k1.stop()
		await k2.stop()
	})
})
