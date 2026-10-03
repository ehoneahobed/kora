/**
 * One value domain, property-tested end to end (RT-86, RT-87).
 *
 * For random values of every field type (valid and invalid, seeded), a value the local
 * API ACCEPTS must be stored and synced unchanged by every built-in server store
 * (memory, SQLite, Postgres when KORA_PG_TEST_URL is set) and every peer's client store:
 * device A writes, B receives through the server over the protobuf wire codec, and A's
 * row, B's row and the server's row are equal. A value the API refuses is refused up front with a clear error and
 * writes nothing. Nothing is ever refused or quarantined after the API accepted it.
 *
 * KORA_VALUE_DOMAIN_SEEDS widens the sweep (records per store, default 60).
 */
import { createRequire } from 'node:module'
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { PostgresServerStore, SqliteServerStore } from '@korajs/server'
import type { ServerStore } from '@korajs/server'
import { afterAll, describe, expect, test } from 'vitest'
import { type TestDevice, createTestNetwork, wrapTransportPairWithProtobufWire } from '../src/index'
import { mulberry32 } from './fold-gate/workload'
import type { Rng } from './fold-gate/workload'

const RECORDS = Number(process.env.KORA_VALUE_DOMAIN_SEEDS ?? 60)
const PG_URL = process.env.KORA_PG_TEST_URL

const schema = defineSchema({
	version: 1,
	collections: {
		vals: {
			fields: {
				s: t.string().optional(),
				n: t.number().optional(),
				b: t.boolean().optional(),
				ts: t.timestamp().optional(),
				e: t.enum(['a', 'b']).optional(),
				tags: t.array(t.string()).optional(),
				days: t.array(t.timestamp()).optional(),
				obj: t.object({ a: t.string().optional(), k: t.number().optional() }).optional(),
				doc: t.json().optional(),
			},
		},
	},
}) as unknown as SchemaDefinition

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T

const STRINGS = [
	'',
	'plain',
	'\u0000',
	'nul\u0000inside',
	'\ud800',
	'lone \udc00 low',
	'￿',
	'￿0',
	'😀 emoji',
	'line sep',
	'quote " back \\ slash',
	'x'.repeat(2000),
	'{"a":1}',
	'2026-10-03T00:00:00.000Z',
]
const NUMBERS = [
	0,
	-0,
	1,
	-1,
	0.1 + 0.2,
	1e308,
	-1e308,
	5e-324,
	2 ** 53,
	-(2 ** 53),
	2 ** 53 + 2,
	123.456,
	Number.NaN,
	Number.POSITIVE_INFINITY,
]
const TIMESTAMPS = [
	0, 1_791_000_000_000, -8_640_000_000_000_000, 8_640_000_000_000_000, -1, 1_791_000_000_000.5,
	1e20, 8_640_000_000_000_001,
]

function randomJson(rng: Rng, depth: number): unknown {
	const r = rng()
	if (depth <= 0 || r < 0.35) {
		return pick(rng, [pick(rng, STRINGS), pick(rng, NUMBERS.slice(0, 12)), true, false, null])
	}
	if (r < 0.6) {
		return Array.from({ length: Math.floor(rng() * 4) }, () => randomJson(rng, depth - 1))
	}
	const out: Record<string, unknown> = {}
	for (let i = 0; i < Math.floor(rng() * 4); i++) {
		out[pick(rng, ['a', 'b', '', '\u0000k', 'é', '$koraBytes', '0', '1', ' ', '__kora_bytes__'])] =
			randomJson(rng, depth - 1)
	}
	return out
}

function deep(levels: number): unknown {
	let value: unknown = 1
	for (let i = 0; i < levels; i++) value = [value]
	return value
}

function randomValue(rng: Rng, field: string): unknown {
	switch (field) {
		case 's':
			return pick(rng, [...STRINGS, 42])
		case 'n':
			return pick(rng, NUMBERS)
		case 'b':
			return pick(rng, [true, false, 0])
		case 'ts':
			return pick(rng, TIMESTAMPS)
		case 'e':
			return pick(rng, ['a', 'b', 'c'])
		case 'tags':
			return Array.from({ length: Math.floor(rng() * 4) }, () => pick(rng, STRINGS.slice(0, 11)))
		case 'days':
			return Array.from({ length: Math.floor(rng() * 3) }, () => pick(rng, TIMESTAMPS))
		case 'obj':
			return { a: pick(rng, STRINGS.slice(0, 11)), k: pick(rng, NUMBERS) }
		case 'doc': {
			const r = rng()
			if (r < 0.05) return deep(70)
			if (r < 0.1) return JSON.parse('{"__proto__":{"x":1}}')
			if (r < 0.13) return { when: new Date(1_791_000_000_000) }
			return randomJson(rng, 3)
		}
	}
	return null
}

const FIELDS = ['s', 'n', 'b', 'ts', 'e', 'tags', 'days', 'obj', 'doc']

function randomRecord(rng: Rng): Record<string, unknown> {
	const record: Record<string, unknown> = {}
	for (const field of FIELDS) if (rng() < 0.6) record[field] = randomValue(rng, field)
	return record
}

/** Field values only, in a comparable form (key order and metadata ignored). */
function view(row: Record<string, unknown> | null | undefined): string {
	if (!row) return 'null'
	const out: Record<string, unknown> = {}
	for (const field of FIELDS) {
		let value = row[field] ?? null
		// A server row may hold a boolean column as 0/1.
		if (field === 'b' && (value === 0 || value === 1)) value = value === 1
		out[field] = value
	}
	return JSON.stringify(out, (_key, value) =>
		value && typeof value === 'object' && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
			: value,
	)
}

const pgClients: Array<{ end: () => Promise<void> }> = []
afterAll(async () => {
	for (const client of pgClients) await client.end().catch(() => {})
})

async function serverStore(kind: string): Promise<ServerStore | undefined> {
	if (kind === 'memory') return undefined
	const serverRequire = createRequire(
		createRequire(import.meta.url).resolve('@korajs/server/package.json'),
	)
	if (kind === 'sqlite') {
		const Database = serverRequire('better-sqlite3') as new (path: string) => unknown
		const { drizzle } = serverRequire('drizzle-orm/better-sqlite3') as {
			drizzle: (db: unknown) => ConstructorParameters<typeof SqliteServerStore>[0]
		}
		return new SqliteServerStore(drizzle(new Database(':memory:')), 'server-sqlite')
	}
	const postgres = serverRequire('postgres') as (
		url: string,
		options?: object,
	) => { unsafe: (sql: string) => Promise<unknown>; end: () => Promise<void> }
	const { drizzle } = serverRequire('drizzle-orm/postgres-js') as {
		drizzle: (client: unknown) => ConstructorParameters<typeof PostgresServerStore>[0]
	}
	const name = `kora_value_domain_rt_${process.pid}`
	const admin = postgres(PG_URL as string, { onnotice: () => {} })
	await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
	await admin.unsafe(`CREATE SCHEMA ${name}`)
	await admin.end()
	const client = postgres(PG_URL as string, {
		max: 4,
		onnotice: () => {},
		connection: { search_path: name },
	})
	pgClients.push(client)
	return new PostgresServerStore(drizzle(client), 'server-pg')
}

const STORES = ['memory', 'sqlite', ...(PG_URL ? ['postgres'] : [])]

describe.each(STORES)('value domain round trip through the %s server store', (kind) => {
	test(`${RECORDS} random records: accepted locally => stored and synced unchanged everywhere`, async () => {
		const rng = mulberry32(0x76616c ^ kind.length)
		const store = await serverStore(kind)
		const network = await createTestNetwork(schema, {
			devices: 2,
			...(store ? { serverStore: store } : {}),
			// Every message crosses the protobuf wire codec (op data as JSON inside it).
			wrapTransport: wrapTransportPairWithProtobufWire,
		})
		try {
			const [a, b] = network.devices as [TestDevice, TestDevice]
			const accepted: string[] = []
			let refused = 0
			for (let i = 0; i < RECORDS; i++) {
				try {
					const row = await a.collection('vals').insert(randomRecord(rng))
					accepted.push(String(row.id))
				} catch (error) {
					refused += 1
					expect((error as { code?: string }).code).toMatch(/SCHEMA_VALIDATION|NON_CANONICAL/)
				}
				// Updates with random values too, over accepted records.
				if (accepted.length > 0 && rng() < 0.5) {
					const id = pick(rng, accepted)
					const patch: Record<string, unknown> = {}
					patch[pick(rng, FIELDS)] = randomValue(rng, pick(rng, FIELDS))
					await a
						.collection('vals')
						.update(id, patch)
						.catch((error: { code?: string }) => {
							refused += 1
							expect(error.code).toMatch(/SCHEMA_VALIDATION|NON_CANONICAL/)
						})
				}
			}
			for (let pass = 0; pass < 2; pass++) {
				await a.sync()
				await b.sync()
			}
			expect(await a.getRejectedOperations()).toEqual([])
			expect(await b.getSyncEngine()?.getQuarantinedOperations()).toEqual([])
			const mismatches: string[] = []
			for (const id of accepted) {
				const onA = view(await a.collection('vals').findById(id))
				const onB = view(await b.collection('vals').findById(id))
				const onServer = view(
					(await network.server.store.findRecord('vals', id)) as Record<string, unknown> | null,
				)
				if (onA !== onB || onA !== onServer) {
					mismatches.push(`${id}\n A=${onA}\n B=${onB}\n S=${onServer}`)
				}
			}
			expect(mismatches.slice(0, 3)).toEqual([])
			// The sweep exercised both sides of the domain.
			expect(accepted.length).toBeGreaterThan(RECORDS / 8)
			expect(refused).toBeGreaterThan(0)
		} finally {
			await network.close()
		}
	}, 120_000)
})

describe('RT-86: an oversized write the server refuses never wedges the device', () => {
	test('a device with a larger local limit: refused per operation, reported, later writes sync', async () => {
		const network = await createTestNetwork(schema, {
			devices: 2,
			// The device allows more than the server (a misconfiguration): the server's
			// per-operation refusal is what keeps the stream moving.
			deviceMaxOperationBytes: 1024 * 1024,
		})
		try {
			const [a, b] = network.devices as [TestDevice, TestDevice]
			const big = await a.collection('vals').insert({ s: 'x'.repeat(300 * 1024) })
			await a.collection('vals').insert({ s: 'small' })
			for (let i = 0; i < 2; i++) {
				await a.sync()
				await b.sync()
			}
			const rejected = await a.getRejectedOperations()
			expect(rejected.map((entry) => entry.code)).toEqual(['OPERATION_TOO_LARGE'])
			expect((await b.getState('vals')).map((row) => row.s)).toEqual(['small'])
			// The writer folds without its refused write, like the server and the peer.
			expect(await a.collection('vals').findById(String(big.id))).toBeNull()
		} finally {
			await network.close()
		}
	}, 60_000)
})
