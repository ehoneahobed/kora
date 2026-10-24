/**
 * Round-2 review of #65, disclosure case: ann owns d1 and its comment c1; an older
 * instance (a rolling deploy) deletes c1; cat is then granted d1; an offline device's
 * older edit of c1 (`STALE-SECRET`) uploads. cat joined after c1 was deleted, so cat must
 * receive neither the stale write nor anything of c1. Runs on SQLite, and on Postgres
 * with KORA_PG_TEST_URL.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, foldRecord, materialize, member, owner, t } from '@korajs/core'
import type { KoraEvent, Operation } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import type { SyncMessage } from '@korajs/sync'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import type { LogEntry } from '../../src/logging/structured-logger'
import { MAX_TOMBSTONE_LOOKBACK } from '../../src/store/live-views'
import type { MemoryServerStore } from '../../src/store/memory-server-store'
import { PostgresServerStore } from '../../src/store/postgres-server-store'
import type { ServerStore } from '../../src/store/server-store'
import { SqliteServerStore } from '../../src/store/sqlite-server-store'
import { createHarness, deliveredOpIds, makeOp, sendAndAwaitAck } from '../repro/rt-fixture'

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit', 'manage'],
		groups: { documents: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: { fields: { userId: t.string(), group: t.string(), role: t.string() } },
		documents: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: member('id'), create: owner('ownerId'), delete: member('id', 'manage') },
		},
		comments: {
			fields: { documentId: t.string(), body: t.string(), pinned: t.boolean().optional() },
			access: {
				read: member('documentId', 'view', { group: 'documents' }),
				create: member('documentId', 'view', { group: 'documents' }),
				update: member('documentId', 'view', { group: 'documents' }),
				delete: member('documentId', 'view', { group: 'documents' }),
			},
		},
	},
})

const auth = new TokenAuthProvider({
	validate: async (token) => (['ann', 'cat'].includes(token) ? { userId: token } : null),
})
const FRESH = { supportsScopeDisjunction: true, lastDeliverySequence: 0 } as Partial<SyncMessage>

interface Backend {
	store: ServerStore
	sql: (query: string, params: unknown[]) => Promise<Record<string, unknown>[]>
	placeholder: (n: number) => string
	done: () => Promise<void>
}

const tmp = mkdtempSync(join(tmpdir(), 'kora-leak-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const PG_URL = process.env.KORA_PG_TEST_URL
const backends: Array<[string, () => Promise<Backend>]> = [
	[
		'sqlite',
		async () => {
			const db = new Database(join(tmp, `leak-${Math.random()}.sqlite`))
			return {
				store: new SqliteServerStore(drizzle(db), 's'),
				sql: async (query, params) => {
					const statement = db.prepare(query)
					if (statement.reader) return statement.all(...params) as Record<string, unknown>[]
					statement.run(...params)
					return []
				},
				placeholder: () => '?',
				done: async () => {},
			}
		},
	],
]
if (PG_URL) {
	backends.push([
		'postgres',
		async () => {
			const name = `kora_leak_${process.pid}_${Math.floor(Math.random() * 1e9)}`
			const admin = postgres(PG_URL, { max: 1 })
			await admin.unsafe(`CREATE SCHEMA ${name}`)
			await admin.end()
			const client = postgres(PG_URL, { max: 4, connection: { search_path: name } })
			return {
				store: new PostgresServerStore(drizzlePg(client), 's'),
				sql: async (query, params) =>
					[...(await client.unsafe(query, params as never[]))] as Record<string, unknown>[],
				placeholder: (n) => `$${n}`,
				done: async () => {
					await client.end()
					const drop = postgres(PG_URL, { max: 1 })
					await drop.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
					await drop.end()
				},
			}
		},
	])
}

/** Apply as an instance that keeps no live views (see live-view-trust.test.ts). */
/** The operations of one record a client received in operation batches, in order. */
function receivedOps(messages: SyncMessage[], recordId: string): Operation[] {
	return messages.flatMap((m) =>
		m.type === 'operation-batch'
			? (m.operations as Operation[]).filter((op) => op.recordId === recordId)
			: [],
	)
}

async function applyAsOlderInstance(backend: Backend, operation: Operation): Promise<void> {
	const p = backend.placeholder
	const fold = await backend.sql(
		`SELECT lv_through, lv_fields FROM kora_fold_state WHERE collection = ${p(1)} AND record_id = ${p(2)}`,
		[operation.collection, operation.recordId],
	)
	const views = await backend.sql(
		`SELECT views FROM kora_record_live_views WHERE collection = ${p(1)} AND record_id = ${p(2)}`,
		[operation.collection, operation.recordId],
	)
	await backend.store.applyRemoteOperation(operation)
	await backend.sql(
		`UPDATE kora_fold_state SET lv_through = ${p(1)}, lv_fields = ${p(2)} WHERE collection = ${p(3)} AND record_id = ${p(4)}`,
		[
			fold[0]?.lv_through ?? null,
			fold[0]?.lv_fields ?? null,
			operation.collection,
			operation.recordId,
		],
	)
	if (views[0]) {
		await backend.sql(
			`UPDATE kora_record_live_views SET views = ${p(1)} WHERE collection = ${p(2)} AND record_id = ${p(3)}`,
			[views[0].views, operation.collection, operation.recordId],
		)
	}
	const snapshot = await backend.sql(`SELECT scope_snapshot FROM operations WHERE id = ${p(1)}`, [
		operation.id,
	])
	const parsed = JSON.parse(String(snapshot[0]?.scope_snapshot)) as Record<string, unknown>
	parsed.deleted = undefined
	await backend.sql(`UPDATE operations SET scope_snapshot = ${p(1)} WHERE id = ${p(2)}`, [
		JSON.stringify(parsed),
		operation.id,
	])
}

describe.each(backends)('a stale write onto a deleted comment (%s)', (_name, make) => {
	test('never reaches a member who joined after the delete', async () => {
		const backend = await make()
		const harness = await createHarness(
			schema,
			auth,
			{},
			backend.store as unknown as MemoryServerStore,
		)
		const ann = await harness.login('ann', 'ann-node', FRESH)
		const now = Date.now()
		const doc = makeOp('ann-node', 1, {
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'doc', ownerId: 'ann' },
			timestamp: { wallTime: now, logical: 0, nodeId: 'ann-node' },
		})
		const comment = makeOp('ann-node', 2, {
			collection: 'comments',
			recordId: 'c1',
			data: { documentId: 'd1', body: 'first' },
			timestamp: { wallTime: now + 1, logical: 0, nodeId: 'ann-node' },
		})
		await sendAndAwaitAck(ann, [doc, comment])
		await harness.settle()
		await backend.store.whenLiveViewsIdle?.()
		// An older instance deletes c1 (it keeps no live views).
		await applyAsOlderInstance(
			backend,
			makeOp('ann-node', 3, {
				type: 'delete',
				collection: 'comments',
				recordId: 'c1',
				data: null,
				timestamp: { wallTime: now + 10, logical: 0, nodeId: 'ann-node' },
			}),
		)
		await harness.server.access.grant({ userId: 'cat', group: ['documents', 'd1'], role: 'view' })
		// An offline device's edit, older than the delete, uploads now.
		const stale = makeOp('ann-tablet', 1, {
			type: 'update',
			collection: 'comments',
			recordId: 'c1',
			data: { body: 'STALE-SECRET' },
			timestamp: { wallTime: now + 5, logical: 0, nodeId: 'ann-tablet' },
		})
		const tablet = await harness.login('ann', 'ann-tablet', FRESH)
		await sendAndAwaitAck(tablet, [stale])
		await harness.settle()
		const cat = await harness.login('cat', 'cat-node', FRESH)
		await harness.settle()
		expect(deliveredOpIds(cat.messages)).not.toContain(stale.id)
		expect(JSON.stringify(cat.messages)).not.toContain('STALE-SECRET')
		await harness.server.stop()
		await backend.store.close()
		await backend.done()
	})

	test('a second, newer delete does not let a member who joined in between receive it', async () => {
		const backend = await make()
		const harness = await createHarness(
			schema,
			auth,
			{},
			backend.store as unknown as MemoryServerStore,
		)
		const ann = await harness.login('ann', 'ann-node', FRESH)
		const now = Date.now()
		const doc = makeOp('ann-node', 1, {
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'doc', ownerId: 'ann' },
			timestamp: { wallTime: now, logical: 0, nodeId: 'ann-node' },
		})
		const comment = makeOp('ann-node', 2, {
			collection: 'comments',
			recordId: 'c1',
			data: { documentId: 'd1', body: 'first' },
			timestamp: { wallTime: now + 1, logical: 0, nodeId: 'ann-node' },
		})
		await sendAndAwaitAck(ann, [doc, comment])
		await harness.settle()
		await backend.store.whenLiveViewsIdle?.()
		// An older instance deletes c1 (it keeps no live views).
		await applyAsOlderInstance(
			backend,
			makeOp('ann-node', 3, {
				type: 'delete',
				collection: 'comments',
				recordId: 'c1',
				data: null,
				timestamp: { wallTime: now + 10, logical: 0, nodeId: 'ann-node' },
			}),
		)
		await harness.server.access.grant({ userId: 'cat', group: ['documents', 'd1'], role: 'view' })
		// A second, newer delete from another offline device lands on the tombstone.
		const phone = await harness.login('ann', 'ann-phone', FRESH)
		await sendAndAwaitAck(phone, [
			makeOp('ann-phone', 1, {
				type: 'delete',
				collection: 'comments',
				recordId: 'c1',
				data: null,
				timestamp: { wallTime: now + 20, logical: 0, nodeId: 'ann-phone' },
			}),
		])
		await harness.settle()
		// An offline device's edit, older than the delete, uploads now.
		const stale = makeOp('ann-tablet', 1, {
			type: 'update',
			collection: 'comments',
			recordId: 'c1',
			data: { body: 'STALE-SECRET' },
			timestamp: { wallTime: now + 5, logical: 0, nodeId: 'ann-tablet' },
		})
		const tablet = await harness.login('ann', 'ann-tablet', FRESH)
		await sendAndAwaitAck(tablet, [stale])
		await harness.settle()
		const cat = await harness.login('cat', 'cat-node', FRESH)
		await harness.settle()
		expect(deliveredOpIds(cat.messages)).not.toContain(stale.id)
		expect(JSON.stringify(cat.messages)).not.toContain('STALE-SECRET')
		await harness.server.stop()
		await backend.store.close()
		await backend.done()
	})

	test('a failed lookup of where the deletion began holds the stream before the write (logged, counted, emitted), then sends it', async () => {
		const backend = await make()
		const logs: LogEntry[] = []
		const events: KoraEvent[] = []
		const emitter = new SimpleEventEmitter()
		emitter.on('server:tombstone-delivery-undetermined', (event) => events.push(event))
		const harness = await createHarness(
			schema,
			auth,
			{ logger: { log: (entry) => logs.push(entry) }, emitter },
			backend.store as unknown as MemoryServerStore,
		)
		const store = backend.store as ServerStore
		// The summary stays unknown, and the deletion's start cannot be read.
		const lookup = store.getTombstoneStart?.bind(store)
		store.getRecordLiveViews = async () => new Map()
		store.requestLiveViewRebuild = () => {}
		store.getTombstoneStart = async () => {
			throw new Error('lookup unavailable')
		}
		const ann = await harness.login('ann', 'ann-node', FRESH)
		const now = Date.now()
		await sendAndAwaitAck(ann, [
			makeOp('ann-node', 1, {
				collection: 'documents',
				recordId: 'd1',
				data: { title: 'doc', ownerId: 'ann' },
				timestamp: { wallTime: now, logical: 0, nodeId: 'ann-node' },
			}),
			makeOp('ann-node', 2, {
				collection: 'comments',
				recordId: 'c1',
				data: { documentId: 'd1', body: 'first' },
				timestamp: { wallTime: now + 1, logical: 0, nodeId: 'ann-node' },
			}),
		])
		// cat is a member before the delete: it may receive the stale write.
		await harness.server.access.grant({ userId: 'cat', group: ['documents', 'd1'], role: 'view' })
		await sendAndAwaitAck(ann, [
			makeOp('ann-node', 3, {
				type: 'delete',
				collection: 'comments',
				recordId: 'c1',
				data: null,
				timestamp: { wallTime: now + 10, logical: 0, nodeId: 'ann-node' },
			}),
		])
		const stale = makeOp('ann-tablet', 1, {
			type: 'update',
			collection: 'comments',
			recordId: 'c1',
			data: { body: 'STALE-SECRET' },
			timestamp: { wallTime: now + 5, logical: 0, nodeId: 'ann-tablet' },
		})
		const tablet = await harness.login('ann', 'ann-tablet', FRESH)
		await sendAndAwaitAck(tablet, [stale])
		await harness.settle()
		const errorsBefore = harness.server.getMetricsCollector().getSnapshot(0).errorCount
		const cat = await harness.login('cat', 'cat-node', FRESH)
		await harness.settle()
		// Held, not withheld: the watermark stops before the write.
		expect(deliveredOpIds(cat.messages)).not.toContain(stale.id)
		const logged = logs.filter((entry) => entry.event === 'session.tombstone_delivery_undetermined')
		expect(logged[0]).toMatchObject({
			level: 'error',
			error: 'lookup unavailable',
			details: {
				collection: 'comments',
				recordId: 'c1',
				operationId: stale.id,
				reason: 'lookup-failed',
				action: 'held',
			},
		})
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'server:tombstone-delivery-undetermined',
				operationId: stale.id,
				reason: 'lookup-failed',
				action: 'held',
				message: 'lookup unavailable',
			}),
		)
		expect(harness.server.getMetricsCollector().getSnapshot(0).errorCount).toBeGreaterThan(
			errorsBefore,
		)
		// The lookup works again: the next push re-judges the write and sends it.
		store.getTombstoneStart = lookup
		await harness.server.pollDeliveryLog()
		await harness.settle()
		expect(deliveredOpIds(cat.messages)).toContain(stale.id)
		await harness.server.stop()
		await backend.store.close()
		await backend.done()
	})

	test('a hold that cannot resolve in time sends the write (as before access rules) and says so', async () => {
		const backend = await make()
		const logs: LogEntry[] = []
		const events: KoraEvent[] = []
		const emitter = new SimpleEventEmitter()
		emitter.on('server:tombstone-delivery-undetermined', (event) => events.push(event))
		const harness = await createHarness(
			schema,
			auth,
			{ logger: { log: (entry) => logs.push(entry) }, emitter },
			backend.store as unknown as MemoryServerStore,
		)
		const store = backend.store as ServerStore
		// The summary stays unknown, and the deletion's start cannot be read.
		const lookup = store.getTombstoneStart?.bind(store)
		store.getRecordLiveViews = async () => new Map()
		store.requestLiveViewRebuild = () => {}
		store.getTombstoneStart = async () => {
			throw new Error('lookup unavailable')
		}
		const ann = await harness.login('ann', 'ann-node', FRESH)
		const now = Date.now()
		await sendAndAwaitAck(ann, [
			makeOp('ann-node', 1, {
				collection: 'documents',
				recordId: 'd1',
				data: { title: 'doc', ownerId: 'ann' },
				timestamp: { wallTime: now, logical: 0, nodeId: 'ann-node' },
			}),
			makeOp('ann-node', 2, {
				collection: 'comments',
				recordId: 'c1',
				data: { documentId: 'd1', body: 'first' },
				timestamp: { wallTime: now + 1, logical: 0, nodeId: 'ann-node' },
			}),
		])
		// cat is a member before the delete: it may receive the stale write.
		await harness.server.access.grant({ userId: 'cat', group: ['documents', 'd1'], role: 'view' })
		await sendAndAwaitAck(ann, [
			makeOp('ann-node', 3, {
				type: 'delete',
				collection: 'comments',
				recordId: 'c1',
				data: null,
				timestamp: { wallTime: now + 10, logical: 0, nodeId: 'ann-node' },
			}),
		])
		const stale = makeOp('ann-tablet', 1, {
			type: 'update',
			collection: 'comments',
			recordId: 'c1',
			data: { body: 'STALE-SECRET' },
			timestamp: { wallTime: now + 5, logical: 0, nodeId: 'ann-tablet' },
		})
		const tablet = await harness.login('ann', 'ann-tablet', FRESH)
		await sendAndAwaitAck(tablet, [stale])
		await harness.settle()
		const cat = await harness.login('cat', 'cat-node', FRESH)
		await harness.settle()
		expect(deliveredOpIds(cat.messages)).not.toContain(stale.id)
		const realNow = Date.now.bind(Date)
		const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 60_000)
		try {
			await harness.server.pollDeliveryLog()
			await harness.settle()
		} finally {
			clock.mockRestore()
		}
		expect(deliveredOpIds(cat.messages)).toContain(stale.id)
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'server:tombstone-delivery-undetermined',
				operationId: stale.id,
				reason: 'hold-expired',
				action: 'sent',
			}),
		)
		expect(
			logs.some(
				(entry) =>
					entry.event === 'session.tombstone_delivery_undetermined' &&
					entry.level === 'error' &&
					(entry.details as { action?: string } | undefined)?.action === 'sent',
			),
		).toBe(true)
		await harness.server.stop()
		await backend.store.close()
		await backend.done()
	})

	test('a member who held the record converges after a revival, past an older instance delete', async () => {
		const backend = await make()
		const harness = await createHarness(
			schema,
			auth,
			{},
			backend.store as unknown as MemoryServerStore,
		)
		const ann = await harness.login('ann', 'ann-node', FRESH)
		const now = Date.now()
		const comment = makeOp('ann-node', 2, {
			collection: 'comments',
			recordId: 'c1',
			data: { documentId: 'd1', body: 'first' },
			timestamp: { wallTime: now + 1, logical: 0, nodeId: 'ann-node' },
		})
		await sendAndAwaitAck(ann, [
			makeOp('ann-node', 1, {
				collection: 'documents',
				recordId: 'd1',
				data: { title: 'doc', ownerId: 'ann' },
				timestamp: { wallTime: now, logical: 0, nodeId: 'ann-node' },
			}),
			comment,
		])
		await harness.settle()
		await backend.store.whenLiveViewsIdle?.()
		// An older instance deletes c1 (no tombstone state, no live views).
		await applyAsOlderInstance(
			backend,
			makeOp('ann-phone', 1, {
				type: 'delete',
				collection: 'comments',
				recordId: 'c1',
				data: null,
				timestamp: { wallTime: now + 10, logical: 0, nodeId: 'ann-phone' },
			}),
		)
		const stale = makeOp('ann-tablet', 1, {
			type: 'update',
			collection: 'comments',
			recordId: 'c1',
			data: { body: 'STALE-SECRET' },
			timestamp: { wallTime: now + 5, logical: 0, nodeId: 'ann-tablet' },
		})
		const tablet = await harness.login('ann', 'ann-tablet', FRESH)
		await sendAndAwaitAck(tablet, [stale])
		await harness.settle()
		const desk = await harness.login('ann', 'ann-desk', FRESH)
		await sendAndAwaitAck(desk, [
			makeOp('ann-desk', 1, {
				type: 'update',
				collection: 'comments',
				recordId: 'c1',
				data: { pinned: true },
				timestamp: { wallTime: now + 30, logical: 0, nodeId: 'ann-desk' },
			}),
		])
		await harness.settle()
		// ann's first device held c1 throughout: it folds to what the server holds.
		const received = receivedOps(ann.messages, 'c1')
		const device = foldRecord([comment, ...received], schema).state
		const server = await backend.store.getRecordFoldState?.('comments', 'c1')
		expect(device ? materialize(device)?.body : null).toBe('STALE-SECRET')
		expect(server ? materialize(server)?.body : null).toBe('STALE-SECRET')
		await harness.server.stop()
		await backend.store.close()
		await backend.done()
	})

	test('past more tombstoned operations than the lookback, a member who held receives the write and a late joiner does not', async () => {
		const backend = await make()
		const harness = await createHarness(
			schema,
			auth,
			{},
			backend.store as unknown as MemoryServerStore,
		)
		const ann = await harness.login('ann', 'ann-node', FRESH)
		const now = Date.now()
		await sendAndAwaitAck(ann, [
			makeOp('ann-node', 1, {
				collection: 'documents',
				recordId: 'd1',
				data: { title: 'doc', ownerId: 'ann' },
				timestamp: { wallTime: now, logical: 0, nodeId: 'ann-node' },
			}),
			makeOp('ann-node', 2, {
				collection: 'comments',
				recordId: 'c1',
				data: { documentId: 'd1', body: 'first' },
				timestamp: { wallTime: now + 1, logical: 0, nodeId: 'ann-node' },
			}),
		])
		await sendAndAwaitAck(ann, [
			makeOp('ann-node', 3, {
				type: 'delete',
				collection: 'comments',
				recordId: 'c1',
				data: null,
				timestamp: { wallTime: now + 10_000, logical: 0, nodeId: 'ann-node' },
			}),
		])
		// More stale writes than the lookback reads, all landing on the tombstone.
		const tablet = await harness.login('ann', 'ann-tablet', FRESH)
		const burst = Array.from({ length: MAX_TOMBSTONE_LOOKBACK + 10 }, (_, i) =>
			makeOp('ann-tablet', i + 1, {
				type: 'update',
				collection: 'comments',
				recordId: 'c1',
				data: { body: `stale-${i}` },
				timestamp: { wallTime: now + 100 + i, logical: 0, nodeId: 'ann-tablet' },
			}),
		)
		for (let i = 0; i < burst.length; i += 100)
			await sendAndAwaitAck(tablet, burst.slice(i, i + 100))
		await harness.settle()
		await harness.server.access.grant({ userId: 'cat', group: ['documents', 'd1'], role: 'view' })
		const last = makeOp('ann-tablet', burst.length + 1, {
			type: 'update',
			collection: 'comments',
			recordId: 'c1',
			data: { body: 'STALE-SECRET' },
			timestamp: { wallTime: now + 5_000, logical: 0, nodeId: 'ann-tablet' },
		})
		await sendAndAwaitAck(tablet, [last])
		await harness.settle()
		// The summary is unknown for this test: decided by the tombstone's start alone.
		const store = backend.store as ServerStore
		store.getRecordLiveViews = async () => new Map()
		store.requestLiveViewRebuild = () => {}
		const annLaptop = await harness.login('ann', 'ann-laptop', FRESH)
		const cat = await harness.login('cat', 'cat-node', FRESH)
		await harness.settle()
		expect(deliveredOpIds(annLaptop.messages)).toContain(last.id)
		expect(deliveredOpIds(cat.messages)).not.toContain(last.id)
		expect(JSON.stringify(cat.messages)).not.toContain('STALE-SECRET')
		await harness.server.stop()
		await backend.store.close()
		await backend.done()
	})
})
