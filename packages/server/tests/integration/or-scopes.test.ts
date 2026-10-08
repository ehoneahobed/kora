/**
 * Disjunctive scopes (`$or`, beta.15 access step 1): a grant that admits a record when
 * ANY branch matches ("my own notes OR notes in spaces I belong to"). Every decision
 * (delivery, live relay, uploads, route queries, partition keys) goes through the one
 * matcher, so all of them agree.
 *
 * Runs on the memory store, or on Postgres with KORA_REPRO_STORE=postgres.
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { resolveSessionScopes } from '../../src/scopes/resolve-session-scopes'
import { normalizeScopeMap } from '../../src/scopes/server-scope-filter'
import { batch, createHarness, makeOp, tick } from '../repro/rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { ownerId: t.string(), spaceId: t.string(), body: t.string().default('') } },
	},
})

const aliceGrant = {
	notes: { $or: [{ ownerId: 'alice' }, { spaceId: { $in: ['s1'] } }] },
}

const auth = new TokenAuthProvider({
	validate: async (token) => (token === 'alice' ? { userId: 'alice', scopes: aliceGrant } : null),
})

/** The beta.15 capability a client sends when it can judge `$or` scopes. */
const CAPABLE = { supportsScopeDisjunction: true }

function deliveredRecordIds(messages: SyncMessage[]): string[] {
	const ids: string[] = []
	for (const m of messages) {
		if (m.type !== 'operation-batch') continue
		for (const op of m.operations as Array<{ recordId: string }>) ids.push(op.recordId)
	}
	return ids
}

function rejectionFor(messages: SyncMessage[], operationId: string): string | null {
	for (const m of messages) {
		if (m.type === 'operation-rejected' && m.operationId === operationId) return m.code
	}
	return null
}

async function seeded() {
	const harness = await createHarness(schema, auth)
	const ctx = harness.server.getKoraContext()
	const put = (recordId: string, ownerId: string, spaceId: string) =>
		ctx.apply({ collection: 'notes', type: 'insert', recordId, data: { ownerId, spaceId } })
	await put('mine', 'alice', 'x')
	await put('shared', 'bob', 's1')
	await put('private', 'bob', 's2')
	return { harness, ctx }
}

describe('$or scopes', () => {
	test('delivery sends records matching any branch, and nothing else', async () => {
		const { harness } = await seeded()
		const alice = await harness.login('alice', 'alice-node', {
			lastDeliverySequence: 0,
			...CAPABLE,
		} as Partial<SyncMessage>)
		const delivered = deliveredRecordIds(alice.messages)
		expect(delivered).toContain('mine')
		expect(delivered).toContain('shared')
		expect(delivered).not.toContain('private')
	})

	test('live relay follows the same rule', async () => {
		const { harness, ctx } = await seeded()
		const alice = await harness.login('alice', 'alice-node', {
			lastDeliverySequence: 0,
			...CAPABLE,
		} as Partial<SyncMessage>)
		const before = alice.messages.length
		await ctx.apply({
			collection: 'notes',
			type: 'insert',
			recordId: 'shared-2',
			data: { ownerId: 'carol', spaceId: 's1' },
		})
		await ctx.apply({
			collection: 'notes',
			type: 'insert',
			recordId: 'private-2',
			data: { ownerId: 'carol', spaceId: 's9' },
		})
		await tick()
		const live = deliveredRecordIds(alice.messages.slice(before))
		expect(live).toContain('shared-2')
		expect(live).not.toContain('private-2')
	})

	test('uploads: allowed inside any branch, refused outside all of them', async () => {
		const { harness } = await seeded()
		const alice = await harness.login('alice', 'alice-node', CAPABLE as Partial<SyncMessage>)
		const ownInsert = makeOp('alice-node', 1, {
			collection: 'notes',
			recordId: 'a-new',
			data: { ownerId: 'alice', spaceId: 'z' },
		})
		const sharedInsert = makeOp('alice-node', 2, {
			collection: 'notes',
			recordId: 's-new',
			data: { ownerId: 'alice2', spaceId: 's1' },
		})
		const outside = makeOp('alice-node', 3, {
			collection: 'notes',
			recordId: 'o-new',
			data: { ownerId: 'carol', spaceId: 's9' },
		})
		const editShared = makeOp('alice-node', 4, {
			type: 'update',
			collection: 'notes',
			recordId: 'shared',
			data: { body: 'hi' },
		})
		const moveOut = makeOp('alice-node', 5, {
			type: 'update',
			collection: 'notes',
			recordId: 'shared',
			data: { spaceId: 's2' },
		})
		const editPrivate = makeOp('alice-node', 6, {
			type: 'update',
			collection: 'notes',
			recordId: 'private',
			data: { body: 'x' },
		})
		alice.send(batch([ownInsert, sharedInsert, outside, editShared, moveOut, editPrivate]))
		await tick(120)
		expect(rejectionFor(alice.messages, ownInsert.id)).toBeNull()
		expect(rejectionFor(alice.messages, sharedInsert.id)).toBeNull()
		expect(rejectionFor(alice.messages, outside.id)).toBe('SCOPE_VIOLATION')
		expect(rejectionFor(alice.messages, editShared.id)).toBeNull()
		expect(rejectionFor(alice.messages, moveOut.id)).toBe('SCOPE_VIOLATION')
		expect(rejectionFor(alice.messages, editPrivate.id)).toBe('SCOPE_VIOLATION')
		expect(await harness.store.findRecord('notes', 'a-new')).not.toBeNull()
		expect(await harness.store.findRecord('notes', 's-new')).not.toBeNull()
		expect((await harness.store.findRecord('notes', 'shared'))?.body).toBe('hi')
		expect(await harness.store.findRecord('notes', 'o-new')).toBeNull()
		expect((await harness.store.findRecord('notes', 'shared'))?.spaceId).toBe('s1')
	})

	test('a write cannot move a record out of a branch it was in', async () => {
		const { harness } = await seeded()
		const alice = await harness.login('alice', 'alice-node', CAPABLE as Partial<SyncMessage>)
		// "shared" (bob, s1) is admitted by the space branch; making it alice's own and
		// moving it to another space would take it away from the space.
		const steal = makeOp('alice-node', 1, {
			type: 'update',
			collection: 'notes',
			recordId: 'shared',
			data: { ownerId: 'alice', spaceId: 'elsewhere' },
		})
		alice.send(batch([steal]))
		await tick(120)
		expect(rejectionFor(alice.messages, steal.id)).toBe('SCOPE_VIOLATION')
		const row = await harness.store.findRecord('notes', 'shared')
		expect(row?.ownerId).toBe('bob')
		expect(row?.spaceId).toBe('s1')
	})

	test('a client that cannot judge $or is refused (CLIENT_TOO_OLD) and sent nothing', async () => {
		const { harness } = await seeded()
		const old = await harness.login('alice', 'old-node', {
			lastDeliverySequence: 0,
		} as Partial<SyncMessage>)
		const error = old.messages.find((m) => m.type === 'error')
		expect(error && 'code' in error ? error.code : null).toBe('CLIENT_TOO_OLD')
		expect(old.messages.some((m) => m.type === 'handshake-response')).toBe(false)
		expect(deliveredRecordIds(old.messages)).toEqual([])
	})

	test('a scoped route query applies the disjunction in memory, with limit after filtering', async () => {
		const { ctx } = await seeded()
		const rows = await ctx.query('notes', { scope: aliceGrant, orderBy: 'id' })
		expect(rows.map((row) => row.id).sort()).toEqual(['mine', 'shared'])
		const one = await ctx.query('notes', { scope: aliceGrant, orderBy: 'id', limit: 1 })
		expect(one).toHaveLength(1)
		expect(['mine', 'shared']).toContain(one[0]?.id)
	})
})

describe('normalizeScopeMap with $or', () => {
	test('equivalent grants have one canonical form', () => {
		const a = normalizeScopeMap({
			notes: { $or: [{ spaceId: { $in: ['s2', 's1'] } }, { ownerId: 'alice' }] },
		})
		const b = normalizeScopeMap({
			notes: {
				$or: [{ ownerId: 'alice' }, { spaceId: { $in: ['s1', 's2', 's1'] } }, { ownerId: 'alice' }],
			},
		})
		expect(JSON.stringify(a)).toBe(JSON.stringify(b))
	})

	test('collapses: one branch to a conjunction, an empty branch to unrestricted', () => {
		expect(normalizeScopeMap({ notes: { $or: [{ ownerId: 'a' }] } })).toEqual({
			notes: { ownerId: 'a' },
		})
		expect(normalizeScopeMap({ notes: { $or: [{ ownerId: 'a' }, {}] } })).toEqual({ notes: {} })
	})

	test('keeps numbers Object.is tells apart (0, -0, NaN, Infinity)', () => {
		const out = normalizeScopeMap({
			notes: { v: { $in: [Number.POSITIVE_INFINITY, Number.NaN, 0, -0] } },
		})
		expect((out.notes?.v as { $in: unknown[] }).$in).toHaveLength(4)
		const branches = normalizeScopeMap({
			notes: { $or: [{ v: Number.POSITIVE_INFINITY }, { v: Number.NaN }] },
		})
		expect((branches.notes as { $or: unknown[] }).$or).toHaveLength(2)
	})

	test('a null collection grant is refused, never read as every record', () => {
		expect(() => normalizeScopeMap({ notes: null as never })).toThrow(/Leave the collection out/)
		const resolved = resolveSessionScopes(null, {
			authScopes: { secrets: null as never, notes: { ownerId: 'alice' } },
			authenticated: true,
		})
		expect(resolved?.secrets).toBeUndefined()
		expect(resolved?.notes).toEqual({ ownerId: 'alice' })
	})

	test('refuses malformed disjunctions and undefined values in any branch', () => {
		expect(() => normalizeScopeMap({ notes: { $or: [] } })).toThrow(/\$or/)
		expect(() => normalizeScopeMap({ notes: { $or: [{ a: 1 }], b: 2 } })).toThrow(/\$or/)
		expect(() => normalizeScopeMap({ notes: { $or: [{ a: 1 }, { b: undefined }] } })).toThrow(
			/undefined or null/,
		)
		// A sibling operator is refused, never stripped (stripping `$ne` would widen).
		expect(() =>
			normalizeScopeMap({
				notes: { $or: [{ ownerId: { $in: ['alice'], $ne: 'alice' } }, { b: 1 }] },
			}),
		).toThrow(/only an exact value/)
		expect(() => normalizeScopeMap({ notes: { ownerId: { $ne: 'alice' } } })).toThrow(
			/only an exact value/,
		)
		expect(() => normalizeScopeMap({ notes: { $or: [{ a: { $in: [1, 2, 3] } }] } }, 2)).toThrow(
			/limit/,
		)
	})
})
