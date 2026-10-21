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
import { defineSchema, member, owner, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
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
			fields: { documentId: t.string(), body: t.string() },
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
})
