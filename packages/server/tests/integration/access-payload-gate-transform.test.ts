/**
 * PR #79 review: the payload gate classifies fields through the schema transform. A v1 device
 * writes an update moving a record visible to a member, with an array and a counter field
 * the v2 server schema renamed; the update must be withheld (a scope entry precedes it), never
 * sent with its base cut, because the receiving fold reads the base of the renamed fields.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, member, or, owner, t, where } from '@korajs/core'
import type { Operation, OperationTransform } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { scopeViewKey } from '@korajs/sync/internal'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import type { MemoryServerStore } from '../../src/store/memory-server-store'
import { PostgresServerStore } from '../../src/store/postgres-server-store'
import { SqliteServerStore } from '../../src/store/sqlite-server-store'
import { createHarness, makeOp, sendAndAwaitAck } from '../repro/rt-fixture'

const schema = defineSchema({
	version: 2,
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
			fields: {
				documentId: t.string(),
				body: t.string(),
				visibility: t.string().default('private'),
				labels: t.array(t.string()).default([]),
				score: t.number().merge('counter').default(0),
			},
			access: {
				read: or(
					member('documentId', 'view', { group: 'documents' }),
					where({ visibility: 'shared' }),
				),
				create: member('documentId', 'view', { group: 'documents' }),
				update: member('documentId', 'view', { group: 'documents' }),
				delete: member('documentId', 'view', { group: 'documents' }),
			},
		},
	},
})
/** v1 named the array `tags` and the counter `votes`. */
const rename = (record: Record<string, unknown> | null): Record<string, unknown> | null => {
	if (record === null) return null
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(record)) {
		out[key === 'tags' ? 'labels' : key === 'votes' ? 'score' : key] = value
	}
	return out
}
const transforms: OperationTransform[] = [
	{
		fromVersion: 1,
		toVersion: 2,
		transform: (op) => ({
			...op,
			data: rename(op.data),
			previousData: rename(op.previousData),
			schemaVersion: 2,
		}),
	},
]
const auth = new TokenAuthProvider({
	validate: async (token) => (['ann', 'cat'].includes(token) ? { userId: token } : null),
})
const FRESH = { supportsScopeDisjunction: true, lastDeliverySequence: 0 } as Partial<SyncMessage>
const tmp = mkdtempSync(join(tmpdir(), 'kora-r13rev-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
let n = 0
const PG_URL = process.env.KORA_PG_TEST_URL
const kinds: Array<'sqlite' | 'postgres'> = PG_URL ? ['sqlite', 'postgres'] : ['sqlite']
let kind: 'sqlite' | 'postgres' = 'sqlite'

/** A store of the current kind; closing it also releases what it needed. */
async function openStore(): Promise<SqliteServerStore | PostgresServerStore> {
	n += 1
	if (kind === 'sqlite' || !PG_URL) {
		return new SqliteServerStore(drizzle(new Database(join(tmp, `r-${n}.sqlite`))), 's')
	}
	const name = `kora_gate_${process.pid}_${Math.floor(Math.random() * 1e9)}`
	const admin = postgres(PG_URL, { max: 1 })
	await admin.unsafe(`CREATE SCHEMA ${name}`)
	await admin.end()
	const client = postgres(PG_URL, { max: 4, connection: { search_path: name } })
	const store = new PostgresServerStore(drizzlePg(client), 's')
	const close = store.close.bind(store)
	store.close = async () => {
		await close()
		await client.end()
		const drop = postgres(PG_URL, { max: 1 })
		await drop.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
		await drop.end()
	}
	return store
}

const opsOf = (messages: SyncMessage[]): Operation[] =>
	messages.flatMap((m) => (m.type === 'operation-batch' ? (m.operations as Operation[]) : []))

describe.each(kinds)(
	'payload gate reads base dependence through the schema transform (%s)',
	(backend) => {
		beforeEach(() => {
			kind = backend
		})

		test('an update that makes a record visible written on v1 with renamed array and counter fields is withheld after the scope entry, not sent with a cut base', async () => {
			const store = await openStore()
			const harness = await createHarness(
				schema,
				auth,
				{
					supportedSchemaVersions: { min: 1, max: 2 },
					operationTransforms: transforms,
				},
				store as unknown as MemoryServerStore,
			)
			try {
				const now = Date.now()
				await harness.settle()
				await store.whenLiveViewsIdle?.()
				const ann = await harness.login('ann', 'ann-node', FRESH)
				let seq = 0
				const at = (offset: number) => ({ wallTime: now + offset, logical: 0, nodeId: 'ann-node' })
				await sendAndAwaitAck(ann, [
					...['d1', 'd2'].map((g, i) =>
						makeOp('ann-node', ++seq, {
							collection: 'documents',
							recordId: g,
							data: { title: g, ownerId: 'ann' },
							timestamp: at(i),
						}),
					),
				])
				await harness.settle()
				await harness.server.access.grant({
					userId: 'cat',
					group: ['documents', 'd1'],
					role: 'view',
				})
				const cat = await harness.login('cat', 'cat-live', FRESH)
				await sendAndAwaitAck(ann, [
					makeOp('ann-node', ++seq, {
						collection: 'comments',
						recordId: 'c2',
						data: { documentId: 'd2', body: 'D2-SECRET', tags: ['D2-TAG'], votes: 7 },
						timestamp: at(10),
					}),
				])
				await sendAndAwaitAck(ann, [
					makeOp('ann-node', ++seq, {
						type: 'update',
						collection: 'comments',
						recordId: 'c2',
						data: { visibility: 'shared', body: 'moved', tags: ['d1-tag'], votes: 9 },
						previousData: { visibility: 'private', body: 'D2-SECRET', tags: ['D2-TAG'], votes: 7 },
						timestamp: at(20),
					}),
				])
				await harness.settle()
				const ops = opsOf(cat.messages).filter((o) => o.recordId === 'c2')
				expect(ops.some((o) => o.nodeId === 'kora:scope-entry')).toBe(true)
				// Withheld: the entry holds all the update did, and its base (renamed array and counter)
				// is read by the recipient's fold.
				expect(ops.filter((o) => o.type === 'update')).toHaveLength(0)
				for (const o of ops) {
					const { foldState, ...rest } = o as Operation & { foldState?: string }
					void foldState
					expect(JSON.stringify(rest)).not.toContain('D2-')
				}
				expect(JSON.stringify(ops)).toContain('moved')
			} finally {
				await harness.server.stop()
				await store.close()
			}
		})
	},
)
