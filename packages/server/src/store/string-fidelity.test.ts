/**
 * RT-65: every server store holds every JavaScript string losslessly, in operation
 * data, in materialized rows (TEXT and JSONB columns, object keys included) and in
 * equality filters: U+0000, lone UTF-16 surrogates (high and low), U+FFFF (the
 * Postgres codec's escape introducer), emoji (surrogate pairs) and right-to-left text.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import { MemoryServerStore } from './memory-server-store'
import { PostgresServerStore } from './postgres-server-store'
import type { ServerStore } from './server-store'
import { createSqliteServerStore } from './sqlite-server-store'
import {
	decodePgJsonValue,
	decodePgText,
	encodePgJsonValue,
	encodePgText,
	needsPgTextEncoding,
} from './text-codec'

const PG_URL = process.env.KORA_PG_TEST_URL

const ADVERSARIAL = [
	'nul\u0000inside',
	'\u0000',
	'lone high \ud83d',
	'lone low \ude00 here',
	'\udc00\ud800',
	'escape \uffff0 and \uffffs d800 and \uffffF',
	'emoji 😀 pair',
	'RTL עברית العربية ‮ override',
	'',
	'plain',
]

const schema = defineSchema({
	version: 1,
	collections: {
		notes: {
			fields: {
				title: t.string(),
				tags: t.array(t.string()).default([]),
				meta: t.object({}).optional(),
			},
		},
	},
}) as unknown as SchemaDefinition

describe('Postgres text codec', () => {
	test('round-trips every adversarial string and leaves ordinary text unchanged', () => {
		for (const s of ADVERSARIAL) {
			expect(decodePgText(encodePgText(s))).toBe(s)
			expect(encodePgText(s).includes('\u0000')).toBe(false)
		}
		expect(encodePgText('plain')).toBe('plain')
		expect(encodePgText('emoji 😀 pair')).toBe('emoji 😀 pair')
		expect(needsPgTextEncoding('emoji 😀 pair')).toBe(true) // a pair passes through unchanged
		const nested = { 'k\u0000': ['a\ud800', { x: '\uffff' }] }
		expect(decodePgJsonValue(encodePgJsonValue(nested))).toEqual(nested)
	})

	test('encoding is injective over the adversarial set', () => {
		const encoded = new Set(ADVERSARIAL.map(encodePgText))
		expect(encoded.size).toBe(ADVERSARIAL.length)
	})
})

const pgClients: Array<ReturnType<typeof postgres>> = []
afterAll(async () => {
	for (const client of pgClients) await client.end()
})

const makers: Array<[string, () => Promise<ServerStore>]> = [
	['memory', async () => new MemoryServerStore()],
	['sqlite', async () => createSqliteServerStore({})],
]
if (PG_URL) {
	makers.push([
		'postgres',
		async () => {
			const name = `kora_strings_${process.pid}_${Date.now()}`
			const admin = postgres(PG_URL, { max: 1, onnotice: () => {} })
			await admin.unsafe(`CREATE SCHEMA ${name}`)
			await admin.end()
			const client = postgres(PG_URL, {
				max: 4,
				onnotice: () => {},
				connection: { search_path: name },
			})
			pgClients.push(client)
			return new PostgresServerStore(drizzle(client))
		},
	])
}

describe.each(makers)('%s server store: string fidelity (RT-65)', (_kind, make) => {
	test('op data, rows, object keys and filters keep every string', async () => {
		const store = await make()
		await store.setSchema(schema)
		for (const [i, s] of ADVERSARIAL.entries()) {
			const op: Operation = {
				id: `op-${i}`,
				nodeId: 'device-a',
				type: 'insert',
				collection: 'notes',
				recordId: `r${i}`,
				data: { title: s, tags: [s, 'x'], meta: { [s || 'empty']: s } },
				previousData: null,
				timestamp: { wallTime: 1_790_000_000_000 + i, logical: 0, nodeId: 'device-a' },
				sequenceNumber: i + 1,
				causalDeps: [],
				schemaVersion: 1,
			}
			expect(await store.applyRemoteOperation(op)).toBe('applied')
		}
		const delivered = await store.getOperationsAfterDelivery(0, 100)
		for (const [i, s] of ADVERSARIAL.entries()) {
			const op = delivered.find((d) => d.operation.recordId === `r${i}`)?.operation
			expect(op?.data).toEqual({ title: s, tags: [s, 'x'], meta: { [s || 'empty']: s } })
			const row = await store.findRecord('notes', `r${i}`)
			expect(row?.title).toBe(s)
			expect(row?.tags).toEqual([s, 'x'])
			expect(row?.meta).toEqual({ [s || 'empty']: s })
			const matches = await store.queryCollection('notes', { where: { title: s } })
			expect(matches.map((m) => m.id)).toEqual([`r${i}`])
		}
		expect(await store.countCollection('notes', { title: 'nul\u0000inside' })).toBe(1)
		await store.close()
	})
})

describe('codec migration: rows written before the codec keep U+FFFF (RT-65)', () => {
	const legacy = 'icon \uffff0 not a NUL'
	const insert = (title: string): Operation => ({
		id: 'legacy-op',
		nodeId: 'device-a',
		type: 'insert',
		collection: 'notes',
		recordId: 'legacy',
		data: { title },
		previousData: null,
		timestamp: { wallTime: 1_790_000_000_000, logical: 0, nodeId: 'device-a' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	})

	test('SQLite', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'kora-codec-'))
		const filename = join(dir, 'server.db')
		try {
			const first = createSqliteServerStore({ filename })
			await first.setSchema(schema)
			await first.applyRemoteOperation(insert('placeholder'))
			await first.close()
			// As an older release left it: the raw string in the row, no migration marker.
			const Database = createRequire(import.meta.url)('better-sqlite3')
			const raw = new Database(filename)
			raw.prepare('UPDATE notes SET title = ? WHERE id = ?').run(legacy, 'legacy')
			raw.prepare("DELETE FROM kora_server_meta WHERE key LIKE 'pg_text_codec_v1:%'").run()
			raw.close()
			const upgraded = createSqliteServerStore({ filename })
			await upgraded.setSchema(schema)
			expect((await upgraded.findRecord('notes', 'legacy'))?.title).toBe(legacy)
			await upgraded.close()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test.skipIf(!PG_URL)('Postgres', async () => {
		const name = `kora_codec_${process.pid}_${Date.now()}`
		const admin = postgres(PG_URL as string, { max: 1, onnotice: () => {} })
		await admin.unsafe(`CREATE SCHEMA ${name}`)
		await admin.end()
		const client = postgres(PG_URL as string, {
			max: 4,
			onnotice: () => {},
			connection: { search_path: name },
		})
		pgClients.push(client)
		const first = new PostgresServerStore(drizzle(client))
		await first.setSchema(schema)
		await first.applyRemoteOperation(insert('placeholder'))
		await client`UPDATE notes SET title = ${legacy}, meta = ${JSON.stringify({ k: legacy })}::jsonb WHERE id = 'legacy'`
		await client.unsafe("DELETE FROM kora_server_meta WHERE key LIKE 'pg_text_codec_v1:%'")
		const upgraded = new PostgresServerStore(drizzle(client))
		await upgraded.setSchema(schema)
		const row = await upgraded.findRecord('notes', 'legacy')
		expect(row?.title).toBe(legacy)
		expect(row?.meta).toEqual({ k: legacy })
	})
})
