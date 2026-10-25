/**
 * Issue #78 items 1 and 3: the last outbound gate also covers non-delete operations (an
 * update that moves a record into a member's group must not carry the old group's content as
 * `previousData`), and an uploaded delete carries no payload. Repros S1 and S3 are the
 * red-team's; the rest pin what the fix must keep working.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, member, owner, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
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
			fields: {
				documentId: t.string(),
				body: t.string(),
				tags: t.array(t.string()).default([]),
				votes: t.number().merge('counter').default(0),
			},
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
	validate: async (token) => (['ann', 'cat', 'bob'].includes(token) ? { userId: token } : null),
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

async function setup() {
	const store = await openStore()
	const harness = await createHarness(schema, auth, {}, store as unknown as MemoryServerStore)
	const now = Date.now()
	const ann = await harness.login('ann', 'ann-node', FRESH)
	await sendAndAwaitAck(ann, [
		...['d1', 'd2'].map((g, i) =>
			makeOp('ann-node', i + 1, {
				collection: 'documents',
				recordId: g,
				data: { title: g, ownerId: 'ann' },
				timestamp: { wallTime: now + i, logical: 0, nodeId: 'ann-node' },
			}),
		),
		makeOp('ann-node', 3, {
			collection: 'comments',
			recordId: 'c1',
			data: { documentId: 'd1', body: 'init' },
			timestamp: { wallTime: now + 5, logical: 0, nodeId: 'ann-node' },
		}),
	])
	await harness.settle()
	await store.whenLiveViewsIdle?.()
	return { harness, store, ann, now, context: harness.server.getKoraContext() }
}
async function resume(
	harness: Awaited<ReturnType<typeof setup>>['harness'],
	first: { messages: SyncMessage[] },
	node: string,
) {
	const watermark = Math.max(
		0,
		...first.messages.map((m) => (m.type === 'operation-batch' ? (m.maxDeliverySequence ?? 0) : 0)),
	)
	const accepted = first.messages.find((m) => m.type === 'handshake-response') as
		| { acceptedDownlinkScopes?: Record<string, Record<string, unknown>> }
		| undefined
	const rulesKey = first.messages
		.map((m) => (m as { accessRulesKey?: string }).accessRulesKey)
		.find((k) => k !== undefined)
	return harness.login('cat', node, {
		supportsScopeDisjunction: true,
		lastDeliverySequence: watermark,
		acceptedScopeKey: scopeViewKey(accepted?.acceptedDownlinkScopes),
		acceptedScopeWatermark: watermark,
		accessRulesKey: rulesKey,
	} as Partial<SyncMessage>)
}
const opsOf = (messages: SyncMessage[]): Operation[] =>
	messages.flatMap((m) => (m.type === 'operation-batch' ? (m.operations as Operation[]) : []))

function deleteBody(
	fields: Record<string, unknown>,
	timestamp: { wallTime: number; logical: number; nodeId: string },
): Parameters<typeof makeOp>[2] {
	return {
		type: 'delete',
		collection: 'comments',
		recordId: 'c1',
		timestamp,
		...fields,
	} as unknown as Parameters<typeof makeOp>[2]
}

describe.each(kinds)(
	'outbound gate for non-delete operations, and uploaded deletes (issue #78) (%s)',
	(backend) => {
		beforeEach(() => {
			kind = backend
		})

		test("S1: an update moving a record into the member's group does not carry the old group's content as previousData", async () => {
			const { harness, store, context } = await setup()
			try {
				await harness.server.access.grant({
					userId: 'cat',
					group: ['documents', 'd1'],
					role: 'view',
				})
				await context.apply({
					collection: 'comments',
					type: 'insert',
					recordId: 'c2',
					data: { documentId: 'd2', body: 'D2-SECRET' },
				})
				await context.apply({
					collection: 'comments',
					type: 'update',
					recordId: 'c2',
					data: { documentId: 'd1', body: 'moved' },
				})
				await harness.settle()
				const cat = await harness.login('cat', 'cat-node', FRESH)
				await harness.settle()
				expect(JSON.stringify(opsOf(cat.messages))).not.toContain('D2-SECRET')
				// The record still arrives, in its new group.
				expect(JSON.stringify(opsOf(cat.messages))).toContain('moved')
			} finally {
				await harness.server.stop()
				await store.close()
			}
		})

		const moveSetup = async () => {
			const ctx = await setup()
			await ctx.harness.server.access.grant({
				userId: 'cat',
				group: ['documents', 'd1'],
				role: 'view',
			})
			const cat = await ctx.harness.login('cat', 'cat-live', FRESH)
			await ctx.context.apply({
				collection: 'comments',
				type: 'insert',
				recordId: 'c2',
				data: { documentId: 'd2', body: 'D2-SECRET', tags: ['D2-TAG'], votes: 7 },
			})
			await ctx.context.apply({
				collection: 'comments',
				type: 'update',
				recordId: 'c2',
				data: { documentId: 'd1', body: 'moved', tags: ['d1-tag'], votes: 9 },
			})
			await ctx.harness.settle()
			return { ...ctx, cat }
		}

		test('S1 live: a device connected during the move gets the record whole, and no operation carries old content', async () => {
			const { harness, store, cat } = await moveSetup()
			try {
				const ops = opsOf(cat.messages).filter((o) => o.recordId === 'c2')
				// The record enters the scope as a scope entry; the moving update is not sent after it
				// (the entry holds all it did, and its base would carry the old values of an array and a counter).
				expect(ops.some((o) => o.nodeId === 'kora:scope-entry')).toBe(true)
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

		// KNOWN GAP, reported separately: the folded state a scope entry carries keeps the values
		// of array elements removed before the record entered the scope (a removal must beat a
		// device that merely kept the element), and a counter's base. Stripping them is not
		// convergence-neutral (a stale concurrent add of a removed element would resurrect it),
		// so it is left to a design decision. This test starts failing when the gap is closed.
		test.fails(
			"KNOWN GAP: the scope entry's folded state carries removed array elements of the old group",
			async () => {
				const { harness, store, cat } = await moveSetup()
				try {
					expect(JSON.stringify(opsOf(cat.messages))).not.toContain('D2-TAG')
				} finally {
					await harness.server.stop()
					await store.close()
				}
			},
		)

		test("an update that stays in the member's group keeps its previousData (and so its id verification)", async () => {
			const { harness, store, context } = await setup()
			try {
				await harness.server.access.grant({
					userId: 'cat',
					group: ['documents', 'd1'],
					role: 'view',
				})
				await context.apply({
					collection: 'comments',
					type: 'update',
					recordId: 'c1',
					data: { body: 'second' },
				})
				await harness.settle()
				const cat = await harness.login('cat', 'cat-node', FRESH)
				await harness.settle()
				const update = opsOf(cat.messages).find((o) => o.type === 'update' && o.recordId === 'c1')
				expect(update?.previousData).toMatchObject({ body: 'init' })
			} finally {
				await harness.server.stop()
				await store.close()
			}
		})

		test('S3: a delete uploaded with a payload is refused; a real delete (null data and previousData) is delivered', async () => {
			const { harness, store, ann, now, context } = await setup()
			try {
				await harness.server.access.grant({
					userId: 'cat',
					group: ['documents', 'd1'],
					role: 'view',
				})
				await context.apply({
					collection: 'comments',
					type: 'update',
					recordId: 'c1',
					data: { documentId: 'd2', body: 'D2-SECRET' },
				})
				await harness.settle()
				const ts = { wallTime: now + 30_000, logical: 0, nodeId: 'ann-node' }
				for (const [seq, extra] of [
					[4, { data: { body: 'D2-SECRET-DATA' } }],
					[5, { previousData: { documentId: 'd1', body: 'D2-SECRET-PREV' } }],
					[6, { fieldVersions: { body: ts } }],
					[7, { atomicOps: { votes: { type: 'increment', value: 1 } } }],
				] as const) {
					ann.messages.length = 0
					await sendAndAwaitAck(ann, [
						makeOp('ann-node', seq, deleteBody(Object.assign({ data: null }, extra), ts)),
					])
					const refused = ann.messages.some(
						(m) =>
							m.type === 'operation-rejected' ||
							(m.type === 'error' && JSON.stringify(m).includes('INVALID')),
					)
					expect(refused, JSON.stringify(extra)).toBe(true)
				}
				// Nothing of it was stored: the record is still live.
				const log = await store.getOperationsAfterDelivery(0, 1000)
				expect(
					log.some((d) => d.operation.type === 'delete' && d.operation.nodeId === 'ann-node'),
				).toBe(false)
				// A real delete passes, with the client metadata real deletes carry.
				ann.messages.length = 0
				await sendAndAwaitAck(ann, [
					makeOp('ann-node', 8, {
						type: 'delete',
						collection: 'comments',
						recordId: 'c1',
						data: null,
						previousData: null,
						mutationName: 'removeComment',
						transactionId: 'tx-1',
						timestamp: { wallTime: now + 40_000, logical: 0, nodeId: 'ann-node' },
					} as never),
				])
				await harness.settle()
				const after = await store.getOperationsAfterDelivery(0, 1000)
				expect(
					after.some((d) => d.operation.type === 'delete' && d.operation.nodeId === 'ann-node'),
				).toBe(true)
			} finally {
				await harness.server.stop()
				await store.close()
			}
		})
	},
)
