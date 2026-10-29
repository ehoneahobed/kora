import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Operation } from '@korajs/core'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { PostgresServerStore } from '../../src/store/postgres-server-store'
import type { ServerStore } from '../../src/store/server-store'
import { SqliteServerStore } from '../../src/store/sqlite-server-store'
import { trackPgSchema } from './pg-test-schemas'

/**
 * Store kinds for the delivery visibility index contract tests (C2). Postgres is added
 * when KORA_PG_TEST_URL is set, as in the other store contract tests.
 */
export interface DeliveryStoreHandle {
	kind: 'memory' | 'sqlite' | 'postgres'
	store: ServerStore
	/** Raw SQL with `$n` placeholders (rewritten to `?` on SQLite). Not available on memory. */
	sql: ((query: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) | null
	/** A second store on the same database (a restart, or another instance). */
	open: (() => ServerStore) | null
	/** A further raw connection to the database (Postgres). */
	connect: (() => ReturnType<typeof postgres>) | null
	done: () => Promise<void>
}

export interface DeliveryStoreKind {
	name: DeliveryStoreHandle['kind']
	make: () => Promise<DeliveryStoreHandle>
}

const PG_URL = process.env.KORA_PG_TEST_URL
const tmp = mkdtempSync(join(tmpdir(), 'kora-delivery-'))
let made = 0

/** Removes the SQLite files of this process; call from `afterAll`. */
export function removeDeliveryTempFiles(): void {
	rmSync(tmp, { recursive: true, force: true })
}

/** The store kinds available in this run. */
export function deliveryStoreKinds(): DeliveryStoreKind[] {
	const kinds: DeliveryStoreKind[] = [
		{
			name: 'memory',
			make: async () => ({
				kind: 'memory',
				store: new MemoryServerStore('s'),
				sql: null,
				open: null,
				connect: null,
				done: async () => {},
			}),
		},
		{
			name: 'sqlite',
			make: async () => {
				made += 1
				const file = join(tmp, `db-${made}.sqlite`)
				const raw = new Database(file)
				const opened: Database.Database[] = [raw]
				const toSqlite = (query: string): string => query.replace(/\$\d+/g, '?')
				const stores: ServerStore[] = []
				const store = new SqliteServerStore(drizzle(raw), 's')
				stores.push(store)
				return {
					kind: 'sqlite',
					store,
					sql: async (query, params = []) => {
						const statement = raw.prepare(toSqlite(query))
						if (statement.reader) return statement.all(...params) as Record<string, unknown>[]
						statement.run(...params)
						return []
					},
					open: () => {
						const extra = new Database(file)
						opened.push(extra)
						const next = new SqliteServerStore(drizzle(extra), 's')
						stores.push(next)
						return next
					},
					connect: null,
					done: async () => {
						for (const s of stores) await s.close().catch(() => {})
					},
				}
			},
		},
	]
	if (PG_URL) {
		kinds.push({
			name: 'postgres',
			make: async () => {
				made += 1
				const name = `kora_delivery_${process.pid}_${made}`
				const admin = postgres(PG_URL, { max: 1, onnotice: () => {} })
				await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
				await admin.unsafe(`CREATE SCHEMA ${name}`)
				trackPgSchema(name)
				await admin.end()
				const clients: Array<ReturnType<typeof postgres>> = []
				const client = (): ReturnType<typeof postgres> => {
					const c = postgres(PG_URL, {
						max: 4,
						connection: { search_path: name },
						onnotice: () => {},
					})
					clients.push(c)
					return c
				}
				const raw = client()
				const stores: ServerStore[] = []
				const store = new PostgresServerStore(drizzlePg(client()), 's')
				stores.push(store)
				return {
					kind: 'postgres',
					store,
					sql: async (query, params = []) =>
						[...(await raw.unsafe(query, params as never[]))] as Record<string, unknown>[],
					open: () => {
						const next = new PostgresServerStore(drizzlePg(client()), 's')
						stores.push(next)
						return next
					},
					connect: client,
					done: async () => {
						for (const s of stores) await s.close().catch(() => {})
						for (const c of clients) await c.end()
					},
				}
			},
		})
	}
	return kinds
}

let counter = 0

/** A minimal valid operation for tests; `overrides` replaces any field. */
export function deliveryOp(
	overrides: Partial<Operation> & Pick<Operation, 'collection' | 'recordId'>,
): Operation {
	counter += 1
	return {
		id: `op-${counter}-${Math.random().toString(36).slice(2, 10)}`,
		nodeId: 'node-a',
		type: 'insert',
		data: {},
		previousData: null,
		timestamp: { wallTime: 1_000 + counter, logical: 0, nodeId: 'node-a' },
		sequenceNumber: counter,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}
