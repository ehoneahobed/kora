import { HybridLogicalClock, createOperation, defineSchema, t } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import Database from 'better-sqlite3'
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { describe, expect, test, vi } from 'vitest'
import { KoraSyncServer } from '../server/kora-sync-server'
import { MemoryServerStore } from '../store/memory-server-store'
import { PostgresServerStore } from '../store/postgres-server-store'
import { UnstorableValueError } from '../store/server-store'
import type { ServerStore } from '../store/server-store'
import { SqliteServerStore } from '../store/sqlite-server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'

/**
 * One value domain at the server (RT-86, RT-87): an upload outside it (an oversized
 * operation, a value no store can hold unchanged) is refused per operation and
 * terminally, the acknowledgment moves past it, and the device's later operations are
 * stored. A database refusal of a value is the same per-operation refusal, never a
 * session error.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		notes: {
			fields: {
				title: t.string(),
				due: t.timestamp().optional(),
				kind: t.enum(['a', 'b']).optional(),
			},
		},
	},
})

let seq = 0
async function note(nodeId: string, data: Record<string, unknown>): Promise<Operation> {
	seq += 1
	return createOperation(
		{
			nodeId,
			type: 'insert',
			collection: 'notes',
			recordId: `rec-${seq}`,
			data,
			previousData: null,
			sequenceNumber: seq,
			causalDeps: [],
			schemaVersion: 1,
		},
		new HybridLogicalClock(nodeId),
	)
}

async function session(store: ServerStore, maxOperationBytes?: number) {
	await store.setSchema(schema)
	const server = new KoraSyncServer({
		store,
		...(maxOperationBytes !== undefined ? { maxOperationBytes } : {}),
	})
	const { client, server: transport } = createServerTransportPair()
	const messages: SyncMessage[] = []
	client.onMessage((m) => messages.push(m))
	server.handleConnection(transport)
	client.send({
		type: 'handshake',
		messageId: 'hs',
		nodeId: 'dev',
		versionVector: {},
		schemaVersion: 1,
		sequenceReservation: true,
		protocolVersion: 2,
	} as SyncMessage)
	await vi.waitFor(() => expect(messages.some((m) => m.type === 'handshake-response')).toBe(true))
	const upload = async (ops: Operation[], id: string): Promise<void> => {
		client.send({
			type: 'operation-batch',
			messageId: id,
			operations: ops,
			isFinal: true,
			batchIndex: 0,
		} as SyncMessage)
		await vi.waitFor(() =>
			expect(
				messages.some((m) => m.type === 'acknowledgment' && m.acknowledgedMessageId === id),
			).toBe(true),
		)
	}
	const rejected = () =>
		messages.flatMap((m) =>
			m.type === 'operation-rejected'
				? [{ id: m.operationId, code: m.code, retriable: m.retriable }]
				: [],
		)
	const ack = (id: string) =>
		messages.find((m) => m.type === 'acknowledgment' && m.acknowledgedMessageId === id) as
			| { lastSequenceNumber: number }
			| undefined
	const errors = () => messages.filter((m) => m.type === 'error')
	return { upload, rejected, ack, errors }
}

describe('server value domain (RT-86, RT-87)', () => {
	test('an oversized operation is refused on its own; the ack moves past it; the next is stored', async () => {
		const store = new MemoryServerStore('server-1')
		const s = await session(store, 4 * 1024)
		const big = await note('dev', { title: 'x'.repeat(8 * 1024) })
		const next = await note('dev', { title: 'next' })
		await s.upload([big, next], 'b1')
		expect(s.rejected()).toEqual([{ id: big.id, code: 'OPERATION_TOO_LARGE', retriable: false }])
		expect(s.errors()).toEqual([])
		expect(s.ack('b1')?.lastSequenceNumber).toBe(next.sequenceNumber)
		expect(await store.findRecord('notes', next.recordId)).toMatchObject({ title: 'next' })
	})

	for (const [label, data] of [
		['a fractional timestamp', { title: 'f', due: 1_791_000_000_000.5 }],
		['a timestamp beyond the Date range', { title: 'g', due: 1e20 }],
		['an enum value outside the list', { title: 'h', kind: 'c' }],
	] as const) {
		test(`${label} is refused per operation on every store`, async () => {
			const store = new MemoryServerStore('server-1')
			const s = await session(store)
			const bad = await note('dev', data)
			const next = await note('dev', { title: 'next' })
			await s.upload([bad, next], 'b1')
			expect(s.rejected()).toEqual([
				{ id: bad.id, code: 'SCHEMA_VALIDATION_ERROR', retriable: false },
			])
			expect(s.ack('b1')?.lastSequenceNumber).toBe(next.sequenceNumber)
			expect(await store.findRecord('notes', bad.recordId)).toBeNull()
			expect(await store.findRecord('notes', next.recordId)).toMatchObject({ title: 'next' })
		})
	}

	test('SQLite: a value the database refuses is UNSTORABLE_VALUE (the safety net)', async () => {
		const sqlite = new Database(':memory:')
		const store = new SqliteServerStore(drizzleSqlite(sqlite), 'server-1')
		await store.setSchema(schema)
		// Kora's DDL has no value-domain constraints any more (RT-101); a constraint added by
		// hand stands in for a value the database refuses.
		sqlite.exec(`BEGIN;
			CREATE TABLE notes_guarded AS SELECT * FROM notes WHERE 0;
			DROP TABLE notes;
			CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, "title" TEXT CHECK ("title" <> 'h'), "due" INTEGER, "kind" TEXT, _created_at INTEGER NOT NULL DEFAULT 0, _updated_at INTEGER NOT NULL DEFAULT 0, _deleted INTEGER NOT NULL DEFAULT 0);
			DROP TABLE notes_guarded;
			COMMIT;`)
		const bad = await note('dev', { title: 'h', kind: 'a' })
		await expect(store.applyRemoteOperation(bad)).rejects.toBeInstanceOf(UnstorableValueError)
		// Nothing was written: the store takes the next operation.
		const next = await note('dev', { title: 'next' })
		expect(await store.applyRemoteOperation(next)).toBe('applied')
	})

	test.skipIf(!process.env.KORA_PG_TEST_URL)(
		'Postgres: every class 22/23 data refusal is UNSTORABLE_VALUE (the safety net)',
		async () => {
			const schemaName = `kora_value_domain_${process.pid}`
			const admin = postgres(process.env.KORA_PG_TEST_URL as string, {
				max: 1,
				onnotice: () => {},
			})
			await admin.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
			await admin.unsafe(`CREATE SCHEMA ${schemaName}`)
			await admin.end()
			const client = postgres(process.env.KORA_PG_TEST_URL as string, {
				max: 4,
				onnotice: () => {},
				connection: { search_path: schemaName },
			})
			try {
				const store = new PostgresServerStore(drizzlePg(client), 'server-1')
				await store.setSchema(schema as SchemaDefinition)
				// Kora's DDL has no value-domain constraints any more (RT-101): a hand-added check
				// stands in for 23514, and survives the next start (only enum checks are relaxed).
				await client.unsafe(
					`ALTER TABLE notes ADD CONSTRAINT notes_hand_check CHECK (title <> 'c')`,
				)
				await store.setSchema(schema as SchemaDefinition)
				// 22003 numeric out of range (BIGINT), 22P02 invalid text (fraction), 23514 check.
				for (const data of [
					{ title: 'a', due: 1e20 },
					{ title: 'b', due: 1.5 },
					{ title: 'c', kind: 'a' },
				]) {
					await expect(store.applyRemoteOperation(await note('dev', data))).rejects.toBeInstanceOf(
						UnstorableValueError,
					)
				}
				expect(await store.applyRemoteOperation(await note('dev', { title: 'next' }))).toBe(
					'applied',
				)
			} finally {
				await client.end()
			}
		},
	)
})

describe('route writes (kora.apply) and the value domain', () => {
	test('undefined in an update clears the field; a value outside the domain is refused', async () => {
		const store = new MemoryServerStore('server-1')
		await store.setSchema(schema)
		const server = new KoraSyncServer({ store })
		const kora = server.getKoraContext()
		const created = await kora.apply({
			collection: 'notes',
			type: 'insert',
			data: { title: 'a', due: 1000 },
		})
		expect(created.ok).toBe(true)
		const recordId = created.ok ? created.operation.recordId : ''
		const cleared = await kora.apply({
			collection: 'notes',
			type: 'update',
			recordId,
			data: { due: undefined },
		})
		expect(cleared.ok).toBe(true)
		expect(await store.findRecord('notes', recordId)).toMatchObject({ title: 'a', due: null })
		for (const due of [new Date(), 1.5, 1e20]) {
			const refused = await kora.apply({
				collection: 'notes',
				type: 'update',
				recordId,
				data: { due },
			})
			expect(refused).toMatchObject({
				ok: false,
				code: 'SCHEMA_VALIDATION_ERROR',
				retriable: false,
			})
		}
		expect(await store.findRecord('notes', recordId)).toMatchObject({ due: null })
	})
})
