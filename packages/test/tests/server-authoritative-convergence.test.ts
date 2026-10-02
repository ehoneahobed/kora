import { mkdtempSync, rmSync } from 'node:fs'
/**
 * Phase 3 seam 3: one source of truth for the authoritative node ids.
 *
 * The handshake advertises exactly the node ids the server stores fold with
 * (`KoraSyncServer.authoritativeNodeIds` = `ServerStore.getAuthoritativeNodeIds()`),
 * including the node that authors route writes, side effects and constraint
 * corrections. A `merge('server-authoritative')` field then converges identically on
 * the server (memory, SQLite, Postgres) and on every device: a server write beats any
 * device write of the field whatever its HLC; among server writes the later wins.
 */
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import {
	MemoryServerStore,
	PostgresServerStore,
	type ServerStore,
	createSqliteServerStore,
} from '@korajs/server'
import { afterAll, describe, expect, test } from 'vitest'
import { type TestDevice, type TestNetwork, createTestNetwork } from '../src/index'

const PG_URL = process.env.KORA_PG_TEST_URL

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

async function makeStore(kind: string, dir: string): Promise<ServerStore> {
	if (kind === 'memory') return new MemoryServerStore('server-mem')
	if (kind === 'sqlite') {
		return createSqliteServerStore({ filename: join(dir, 'server.db'), nodeId: 'server-sqlite' })
	}
	const postgres = serverRequire('postgres') as (url: string, o?: object) => PgClient
	const { drizzle } = serverRequire('drizzle-orm/postgres-js') as {
		drizzle: (client: PgClient) => ConstructorParameters<typeof PostgresServerStore>[0]
	}
	const name = `kora_auth_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
	const admin = postgres(PG_URL as string, { onnotice: () => {} })
	await admin.unsafe(`CREATE SCHEMA ${name}`)
	await admin.end()
	pgSchemas.push(name)
	const client = postgres(PG_URL as string, { max: 4, connection: { search_path: name } })
	return new PostgresServerStore(drizzle(client), 'server-pg')
}

afterAll(async () => {
	if (!PG_URL || pgSchemas.length === 0) return
	const postgres = serverRequire('postgres') as (url: string, o?: object) => PgClient
	const admin = postgres(PG_URL, { onnotice: () => {} })
	for (const name of pgSchemas) await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
	await admin.end()
})

async function syncAll(devices: TestDevice[], passes = 2): Promise<void> {
	for (let pass = 0; pass < passes; pass++) for (const device of devices) await device.sync()
}

const kinds = ['memory', 'sqlite', ...(PG_URL ? ['postgres'] : [])]

describe.each(kinds)('server-authoritative field through the %s store', (kind) => {
	test('the handshake carries the stores fold authority, and server, devices converge', async () => {
		const dir = mkdtempSync(join(tmpdir(), `kora-auth-${kind}-`))
		let network: TestNetwork | null = null
		try {
			const store = await makeStore(kind, dir)
			network = await createTestNetwork(schema, { devices: 2, serverStore: store })
			const { server } = network
			const [a, b] = network.devices as [TestDevice, TestDevice]
			await syncAll([a, b], 1)

			// One source of truth: what the stores fold with is what clients learn.
			expect(server.authoritativeNodeIds).toEqual(store.getAuthoritativeNodeIds?.())
			expect(server.authoritativeNodeIds).toContain(store.getNodeId())
			for (const device of [a, b]) {
				expect(device.getSyncEngine()?.getAuthoritativeNodeIds()).toEqual(
					server.authoritativeNodeIds,
				)
			}

			const item = await a.collection('items').insert({ title: 'x', status: 'draft' })
			const id = String(item.id)
			await syncAll([a, b])

			// The server writes first; both devices write the field LATER (higher HLC),
			// offline, and upload afterwards.
			await a.disconnect()
			await b.disconnect()
			const approved = await server
				.getKoraContext()
				.apply({ collection: 'items', type: 'update', recordId: id, data: { status: 'approved' } })
			expect(approved.ok).toBe(true)
			await new Promise((resolve) => setTimeout(resolve, 5))
			await a.collection('items').update(id, { status: 'client-a', title: 'from a' })
			await b.collection('items').update(id, { status: 'client-b' })
			await syncAll([a, b], 3)

			const expected = { title: 'from a', status: 'approved' }
			expect(await store.findRecord('items', id)).toMatchObject(expected)
			expect(await a.collection('items').findById(id)).toMatchObject(expected)
			expect(await b.collection('items').findById(id)).toMatchObject(expected)

			// Among authoritative writes the later wins; device writes still lose.
			const final = await server
				.getKoraContext()
				.apply({ collection: 'items', type: 'update', recordId: id, data: { status: 'final' } })
			expect(final.ok).toBe(true)
			await a.collection('items').update(id, { status: 'client-a-again' })
			await syncAll([a, b], 3)
			for (const view of [
				await store.findRecord('items', id),
				await a.collection('items').findById(id),
				await b.collection('items').findById(id),
			]) {
				expect(view).toMatchObject({ status: 'final' })
			}
			// Route writes are content-hashed (version 2) and verify on every device.
			for (const device of [a, b]) {
				expect(await device.getSyncEngine()?.getQuarantinedOperations()).toEqual([])
			}
		} finally {
			await network?.close()
			rmSync(dir, { recursive: true, force: true })
		}
	}, 60_000)
})
