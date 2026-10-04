/**
 * Phase 3 authority rule, both halves end to end (RT-61, RT-62): the server authors as
 * `kora:server:<deploymentId>:<instanceId>` and the client fold treats the
 * `kora:server:` prefix as authoritative, so a Postgres instance started AFTER a
 * device connected (an id the device was never told about) still wins
 * `merge('server-authoritative')` fields on that device. Legacy server ids (a
 * configured plain node id) are advertised and stay authoritative too.
 *
 * Two PostgresServerStore instances on one database; the device stays connected to
 * instance A only and receives instance B's write through A's delivery polling.
 */
import { createRequire } from 'node:module'
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { KoraSyncServer, PostgresServerStore } from '@korajs/server'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { type TestDevice, createTestNetwork } from '../src/index'

const PG_URL = process.env.KORA_PG_TEST_URL
const LEGACY_ID = 'server-legacy'

const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				status: t.string().merge('server-authoritative'),
			},
		},
	},
}) as unknown as SchemaDefinition

interface PgClient {
	unsafe: (sql: string) => Promise<unknown>
	end: () => Promise<void>
}
const serverRequire = createRequire(
	createRequire(import.meta.url).resolve('@korajs/server/package.json'),
)
const pgSchemas: string[] = []

function pgStore(name: string): PostgresServerStore {
	const postgres = serverRequire('postgres') as (url: string, o?: object) => PgClient
	const { drizzle } = serverRequire('drizzle-orm/postgres-js') as {
		drizzle: (client: PgClient) => ConstructorParameters<typeof PostgresServerStore>[0]
	}
	const client = postgres(PG_URL as string, {
		max: 4,
		onnotice: () => {},
		connection: { search_path: name },
	})
	return new PostgresServerStore(drizzle(client), LEGACY_ID)
}

afterAll(async () => {
	if (!PG_URL || pgSchemas.length === 0) return
	const postgres = serverRequire('postgres') as (url: string, o?: object) => PgClient
	const admin = postgres(PG_URL, { onnotice: () => {} })
	for (const name of pgSchemas) await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
	await admin.end()
})

describe.skipIf(!PG_URL)('authority across Postgres instances (prefix rule)', () => {
	test('an instance started after the device connected wins server-authoritative fields on it', async () => {
		const name = `kora_auth_mi_${process.pid}_${Date.now()}`
		const postgres = serverRequire('postgres') as (url: string, o?: object) => PgClient
		const admin = postgres(PG_URL as string, { onnotice: () => {} })
		await admin.unsafe(`CREATE SCHEMA ${name}`)
		await admin.end()
		pgSchemas.push(name)

		const storeA = pgStore(name)
		const network = await createTestNetwork(schema, { devices: 1, serverStore: storeA })
		let serverB: KoraSyncServer | null = null
		let storeB: PostgresServerStore | null = null
		try {
			const [device] = network.devices as [TestDevice]
			await device.sync()
			const nodeA = storeA.getNodeId()
			expect(nodeA).toMatch(/^kora:server:[^:]+:[^:]+$/)

			// The handshake advertises the legacy (configured plain) id only.
			const learned = device.getSyncEngine()?.getAuthoritativeNodeIds() ?? []
			// Since RT-75 only explicit (non-prefixed) ids are advertised: the kora:server:
			// namespace, A's id included, is authoritative by the prefix rule.
			expect(learned).not.toContain(nodeA)
			expect(learned).toContain(LEGACY_ID)

			const item = await device.collection('items').insert({ title: 'x', status: 'draft' })
			const id = String(item.id)
			await device.sync()

			// Instance B starts now: same deployment, a new instance id the device never saw.
			storeB = pgStore(name)
			await storeB.setSchema(schema)
			serverB = new KoraSyncServer({
				store: storeB,
				relayRetransmitIntervalMs: 0,
				deliveryPollIntervalMs: 0,
			})
			const nodeB = storeB.getNodeId()
			expect(nodeB).not.toBe(nodeA)
			expect(nodeB.split(':')[2]).toBe(nodeA.split(':')[2])
			expect(learned).not.toContain(nodeB)

			const approved = await serverB.getKoraContext().apply({
				collection: 'items',
				type: 'update',
				recordId: id,
				data: { status: 'approved' },
			})
			expect(approved.ok).toBe(true)

			// The device writes the field LATER (higher HLC) while still connected to A.
			await new Promise((resolve) => setTimeout(resolve, 5))
			await device.collection('items').update(id, { status: 'client', title: 'edited' })
			await vi.waitFor(
				async () => {
					await device.sync()
					// Arrives through A's delivery polling; without the prefix rule the device
					// would keep its own later 'client' forever.
					expect(await device.collection('items').findById(id)).toMatchObject({
						status: 'approved',
					})
				},
				{ timeout: 20_000, interval: 250 },
			)
			await device.sync()

			// B's write wins on the device (prefix rule) and on both instances.
			const expected = { title: 'edited', status: 'approved' }
			expect(await device.collection('items').findById(id)).toMatchObject(expected)
			expect(await storeA.findRecord('items', id)).toMatchObject(expected)
			expect(await storeB.findRecord('items', id)).toMatchObject(expected)
			// The device was never told B's id: authority came from the namespace.
			expect(device.getSyncEngine()?.getAuthoritativeNodeIds() ?? []).not.toContain(nodeB)
			expect(await device.getSyncEngine()?.getQuarantinedOperations()).toEqual([])

			// A legacy server id (history from before protocol 2) stays authoritative: its
			// write beats a later device write on every replica.
			const legacy = await storeA.applyRemoteOperation({
				id: 'legacy-server-write',
				nodeId: LEGACY_ID,
				type: 'update',
				collection: 'items',
				recordId: id,
				data: { status: 'legacy-decision' },
				previousData: { status: 'approved' },
				timestamp: { wallTime: Date.now(), logical: 0, nodeId: LEGACY_ID },
				sequenceNumber: 1,
				causalDeps: [],
				schemaVersion: 1,
			})
			expect(legacy).toBe('applied')
			await new Promise((resolve) => setTimeout(resolve, 5))
			await device.collection('items').update(id, { status: 'client-again' })
			await vi.waitFor(
				async () => {
					await device.sync()
					expect(await device.collection('items').findById(id)).toMatchObject({
						status: 'legacy-decision',
					})
				},
				{ timeout: 20_000, interval: 250 },
			)
			expect(await storeA.findRecord('items', id)).toMatchObject({ status: 'legacy-decision' })
		} finally {
			await serverB?.stop()
			await storeB?.close()
			await network.close()
		}
	}, 90_000)
})
