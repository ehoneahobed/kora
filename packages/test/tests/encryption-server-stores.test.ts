import { mkdtempSync, rmSync } from 'node:fs'
/**
 * Phase 3 seam 1: end-to-end encrypted sync through every server store.
 *
 * Two devices with the same key material sync through a memory, a SQLite and a
 * Postgres server store (Postgres when KORA_PG_TEST_URL is set). Asserts:
 * - every stored operation keeps its encryption envelope and its hash version, so a
 *   relayed operation decrypts AND verifies on the other device (nothing quarantined);
 * - the server never materializes sealed values; cleartext scope fields fold;
 * - server-authored operations (a cascade from a delete) reach encrypted devices;
 * - concurrent encrypted edits converge.
 */
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, verifyOperationId } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { t } from '@korajs/core'
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
		projects: { fields: { name: t.string(), ownerId: t.string() } },
		// No cleartext field: every envelope carries data null.
		notes: { fields: { body: t.string(), stars: t.number().default(0) } },
		todos: {
			fields: {
				title: t.string(),
				ownerId: t.string(),
				projectId: t.string().optional(),
				done: t.boolean().default(false),
				tags: t.array(t.string()).default([]),
			},
		},
	},
	relations: {
		todoBelongsToProject: {
			from: 'todos',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'cascade',
		},
	},
}) as unknown as SchemaDefinition

const encryption = {
	config: {
		enabled: true,
		key: 'correct horse battery staple',
		// Scope keys and the relation key travel in cleartext so the server can scope
		// and cascade; everything else is sealed.
		cleartextFields: { todos: ['ownerId', 'projectId'], projects: ['ownerId'] },
	},
	salt: new Uint8Array(16).fill(7),
	iterations: 1_000,
}

const pgSchemas: string[] = []

interface PgClient {
	unsafe: (sql: string) => Promise<unknown>
	end: () => Promise<void>
}

// `postgres` and drizzle are the server package's dependencies, not this one's.
const serverRequire = createRequire(
	createRequire(import.meta.url).resolve('@korajs/server/package.json'),
)
const postgres = serverRequire('postgres') as (
	url: string,
	options?: Record<string, unknown>,
) => PgClient
const { drizzle } = serverRequire('drizzle-orm/postgres-js') as {
	drizzle: (client: PgClient) => ConstructorParameters<typeof PostgresServerStore>[0]
}

async function pgAdmin(): Promise<PgClient> {
	return postgres(PG_URL as string, { onnotice: () => {} })
}

type StoreKind = 'memory' | 'sqlite' | 'postgres'

async function makeStore(kind: StoreKind, dir: string): Promise<ServerStore> {
	if (kind === 'memory') return new MemoryServerStore('server-mem')
	if (kind === 'sqlite') {
		return createSqliteServerStore({ filename: join(dir, 'server.db'), nodeId: 'server-sqlite' })
	}
	const name = `kora_enc_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
	const admin = await pgAdmin()
	await admin.unsafe(`CREATE SCHEMA ${name}`)
	await admin.end()
	pgSchemas.push(name)
	const client = postgres(PG_URL as string, { max: 4, connection: { search_path: name } })
	return new PostgresServerStore(drizzle(client), 'server-pg')
}

afterAll(async () => {
	if (!PG_URL || pgSchemas.length === 0) return
	const admin = await pgAdmin()
	for (const name of pgSchemas) await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
	await admin.end()
})

async function allServerOps(store: ServerStore): Promise<Operation[]> {
	return (await store.getOperationsAfterDelivery(0, 10_000)).map((d) => d.operation)
}

async function quarantined(device: TestDevice): Promise<string[]> {
	const engine = device.getSyncEngine()
	if (!engine) return []
	return (await engine.getQuarantinedOperations()).map((entry) => `${entry.code}: ${entry.message}`)
}

const kinds: StoreKind[] = ['memory', 'sqlite', ...(PG_URL ? (['postgres'] as const) : [])]

describe.each(kinds)('encrypted sync through the %s server store', (kind) => {
	test('stored ops keep envelope + hash version, verify on the other device, and converge', async () => {
		const dir = mkdtempSync(join(tmpdir(), `kora-enc-${kind}-`))
		let network: TestNetwork | null = null
		try {
			const store = await makeStore(kind, dir)
			network = await createTestNetwork(schema, {
				devices: 2,
				serverStore: store,
				encryption,
				serverEncryption: { required: true },
			})
			const [a, b] = network.devices as [TestDevice, TestDevice]
			await a.sync()
			await b.sync()

			const project = await a.collection('projects').insert({ name: 'Secret plan', ownerId: 'u1' })
			const todo = await a.collection('todos').insert({
				title: 'classified',
				ownerId: 'u1',
				projectId: String(project.id),
				tags: ['x'],
			})
			await a.sync()
			await b.sync()

			// Stored opaquely: envelope and hash version survive the store round trip.
			const stored = (await allServerOps(store)).filter((op) => op.nodeId === a.getNodeId())
			expect(stored.length).toBe(2)
			for (const op of stored) {
				expect(op.encrypted, `op ${op.id} lost its envelope`).toBeDefined()
				expect(op.hashVersion).toBe(2)
				expect(op.previousData).toBeNull()
			}
			const todoInsert = stored.find((op) => op.collection === 'todos')
			expect(todoInsert?.data).toEqual({ ownerId: 'u1', projectId: String(project.id) })

			// The server materializes only cleartext fields, never plaintext of sealed ones.
			const serverRow = (await store.findRecord('todos', String(todo.id))) as Record<
				string,
				unknown
			> | null
			expect(serverRow?.ownerId).toBe('u1')
			expect(serverRow?.projectId).toBe(String(project.id))
			expect(serverRow?.title ?? null).toBeNull()
			expect(JSON.stringify(serverRow)).not.toContain('classified')

			// The relayed op decrypted and verified on B.
			expect(await b.collection('todos').findById(String(todo.id))).toMatchObject({
				title: 'classified',
				tags: ['x'],
			})

			// Concurrent sealed edits converge.
			await a.disconnect()
			await b.disconnect()
			await a.collection('todos').update(String(todo.id), { title: 'renamed', tags: ['x', 'a'] })
			await b.collection('todos').update(String(todo.id), { done: true, tags: ['x', 'b'] })
			for (let pass = 0; pass < 2; pass++) {
				await a.sync()
				await b.sync()
			}
			const viewA = await a.collection('todos').findById(String(todo.id))
			const viewB = await b.collection('todos').findById(String(todo.id))
			expect(viewA).toMatchObject({ title: 'renamed', done: true })
			expect(viewB).toEqual(viewA)
			expect([...((viewA?.tags as string[]) ?? [])].sort()).toEqual(['a', 'b', 'x'])

			// A delete of the project: the server cascades (a server-authored op, plaintext,
			// no content hash); encrypted devices accept it and converge.
			await b.collection('projects').delete(String(project.id))
			for (let pass = 0; pass < 2; pass++) {
				await b.sync()
				await a.sync()
			}
			expect(await a.collection('todos').findById(String(todo.id))).toBeNull()
			expect(await b.collection('todos').findById(String(todo.id))).toBeNull()

			for (const op of await allServerOps(store)) {
				if (op.encrypted !== undefined) continue
				// Server-authored plaintext: deterministic ids are exempt from the hash.
				expect(op.hashVersion, `plaintext op ${op.id} declares a content hash`).toBeUndefined()
				expect(op.nodeId).toBe(store.getNodeId())
			}
			for (const op of await allServerOps(store)) {
				if (op.hashVersion === 2 && op.encrypted === undefined) {
					expect(await verifyOperationId(op)).toBe(true)
				}
			}
			// A collection with no cleartext field: envelopes carry data null. The server
			// folds the record's existence (insert, write, delete) but no value.
			const note = await a.collection('notes').insert({ body: 'sealed', stars: 1 })
			await a.sync()
			await b.sync()
			const sealedRow = (await store.findRecord('notes', String(note.id))) as Record<
				string,
				unknown
			> | null
			expect(sealedRow).not.toBeNull()
			expect(sealedRow?.body ?? null).toBeNull()
			expect(await b.collection('notes').findById(String(note.id))).toMatchObject({
				body: 'sealed',
				stars: 1,
			})
			await a.disconnect()
			await b.collection('notes').delete(String(note.id))
			await b.sync()
			await a.collection('notes').update(String(note.id), { stars: 5 })
			for (let pass = 0; pass < 2; pass++) {
				await a.sync()
				await b.sync()
			}
			const noteA = await a.collection('notes').findById(String(note.id))
			expect(await b.collection('notes').findById(String(note.id))).toEqual(noteA)
			const serverNote = (await store.findRecord('notes', String(note.id))) as Record<
				string,
				unknown
			> | null
			const serverLive =
				serverNote !== null && serverNote._deleted !== 1 && serverNote._deleted !== true
			// The server's record existence agrees with the devices'.
			expect(serverLive).toBe(noteA !== null)

			expect(await quarantined(a)).toEqual([])
			expect(await quarantined(b)).toEqual([])
		} finally {
			await network?.close()
			rmSync(dir, { recursive: true, force: true })
		}
	}, 60_000)
})
