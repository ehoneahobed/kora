import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createKoraServer } from '../../src/server/create-server'
import type { KoraSyncServer } from '../../src/server/kora-sync-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import type { ServerStore } from '../../src/store/server-store'
import { createSqliteServerStore } from '../../src/store/sqlite-server-store'
import { makeOp } from '../repro/rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: {
		seats: {
			fields: {
				label: t.string(),
				takenBy: t.string().optional(),
				count: t.number().default(0),
				org: t.string().default('a'),
			},
		},
		notes: {
			fields: { body: t.string(), seatId: t.string().optional(), org: t.string().default('a') },
		},
		files: { fields: { org: t.string(), content: t.blob().optional() } },
		tags: { fields: { name: t.string(), seatId: t.string().optional() } },
	},
	relations: {
		tagSeat: {
			from: 'tags',
			to: 'seats',
			type: 'many-to-one',
			field: 'seatId',
			onDelete: 'restrict',
		},
		noteSeat: {
			from: 'notes',
			to: 'seats',
			type: 'many-to-one',
			field: 'seatId',
			onDelete: 'cascade',
		},
	},
})

const accessSchema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit', 'manage'],
		groups: { docs: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: {
			fields: { userId: t.string(), group: t.string(), role: t.string() },
			access: { read: memberOfKey('group') },
		},
		docs: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: {
				read: member('id'),
				create: owner('ownerId'),
				update: member('id', 'edit'),
				delete: member('id', 'manage'),
			},
		},
	},
})

const dirs: string[] = []
const servers: KoraSyncServer[] = []

async function serverOn(kind: 'memory' | 'sqlite', withAccess = false): Promise<KoraSyncServer> {
	return (await serverAndStore(kind, withAccess)).server
}

async function serverAndStore(
	kind: 'memory' | 'sqlite',
	withAccess = false,
): Promise<{ server: KoraSyncServer; store: ServerStore }> {
	const s = withAccess ? accessSchema : schema
	let store: ServerStore
	if (kind === 'memory') {
		store = new MemoryServerStore()
	} else {
		const dir = mkdtempSync(join(tmpdir(), 'kora-tx-'))
		dirs.push(dir)
		store = createSqliteServerStore({ filename: join(dir, 'server.db') })
	}
	await store.setSchema(s, withAccess ? { accessRulesEnforced: true } : undefined)
	const server = createKoraServer({
		store,
		...(withAccess ? { experimentalAccessRules: true, accessSweepIntervalMs: 0 } : {}),
	})
	servers.push(server)
	return { server, store }
}

afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop?.()
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.each(['memory', 'sqlite'] as const)('kora.transaction on the %s store', (kind) => {
	test('decides on current state and commits its mutations', async () => {
		const kora = (await serverOn(kind)).getKoraContext()
		await kora.apply({ collection: 'seats', type: 'insert', recordId: 's1', data: { label: 'A1' } })
		const result = await kora.transaction(async (tx) => {
			const seat = await tx.findById('seats', 's1')
			if (!seat || seat.takenBy) return tx.reject('TAKEN', 'Taken.')
			return [
				{ collection: 'seats', type: 'update', recordId: 's1', data: { takenBy: 'ann' } },
				{
					collection: 'notes',
					type: 'insert',
					recordId: 'n1',
					data: { body: 'booked', seatId: 's1' },
				},
			]
		})
		expect(result.ok).toBe(true)
		expect((await kora.findById('seats', 's1'))?.takenBy).toBe('ann')
		expect((await kora.findById('notes', 'n1'))?.body).toBe('booked')
	})

	test('a refusal writes nothing', async () => {
		const kora = (await serverOn(kind)).getKoraContext()
		const result = await kora.transaction(async (tx) => tx.reject('NOPE', 'Not now.'))
		expect(result).toEqual({ ok: false, code: 'NOPE', message: 'Not now.', retriable: false })
	})

	test('one invalid mutation writes none of them', async () => {
		const { server, store } = await serverAndStore(kind)
		const kora = server.getKoraContext()
		await kora.apply({ collection: 'seats', type: 'insert', recordId: 's1', data: { label: 'A1' } })
		const before = await store.getOperationCount()
		const result = await kora.transaction(async () => [
			{ collection: 'seats', type: 'update', recordId: 's1', data: { takenBy: 'ann' } },
			{ collection: 'notes', type: 'insert', recordId: 'n1', data: { body: 42 } },
		])
		expect(result.ok).toBe(false)
		expect((await kora.findById('seats', 's1'))?.takenBy ?? null).toBeNull()
		expect(await store.getOperationCount()).toBe(before)
	})

	test('concurrent transactions decide one after the other: one seat, one winner', async () => {
		const kora = (await serverOn(kind)).getKoraContext()
		await kora.apply({ collection: 'seats', type: 'insert', recordId: 's1', data: { label: 'A1' } })
		const take = (user: string) =>
			kora.transaction(async (tx) => {
				const seat = await tx.findById('seats', 's1')
				// Yield inside the decision: another writer would interleave here without the gate.
				await new Promise((resolve) => setTimeout(resolve, 5))
				if (!seat || seat.takenBy) return tx.reject('TAKEN', 'Taken.')
				return [{ collection: 'seats', type: 'update', recordId: 's1', data: { takenBy: user } }]
			})
		const results = await Promise.all(['ann', 'bob', 'cat', 'dan'].map(take))
		expect(results.filter((r) => r.ok)).toHaveLength(1)
	})

	test('a sync-path write arriving during a decision commits after the transaction', async () => {
		const { server, store } = await serverAndStore(kind)
		const kora = server.getKoraContext()
		await kora.apply({ collection: 'seats', type: 'insert', recordId: 's1', data: { label: 'A1' } })
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const order: string[] = []
		const transaction = kora.transaction(async (tx) => {
			const seat = await tx.findById('seats', 's1')
			await gate
			order.push('decided')
			return [
				{
					collection: 'seats',
					type: 'update',
					recordId: 's1',
					data: { count: Number(seat?.count ?? 0) + 1 },
				},
			]
		})
		await new Promise((resolve) => setTimeout(resolve, 10))
		// As a device upload is applied: straight to the store.
		const upload = store
			.applyRemoteOperation(
				makeOp('device-node', 1, {
					type: 'update',
					collection: 'seats',
					recordId: 's1',
					data: { label: 'B2' },
					previousData: { label: 'A1' },
				}),
			)
			.then(() => order.push('upload'))
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(order).toEqual([])
		release()
		expect((await transaction).ok).toBe(true)
		await upload
		expect(order).toEqual(['decided', 'upload'])
	})

	test('applyConditional commits its whole set or nothing', async () => {
		const kora = (await serverOn(kind)).getKoraContext()
		await kora.apply({ collection: 'seats', type: 'insert', recordId: 's1', data: { label: 'A1' } })
		const result = await kora.applyConditional({
			collection: 'seats',
			id: 's1',
			update: { takenBy: 'ann' },
			also: [{ collection: 'notes', type: 'insert', recordId: 'n1', data: { body: 42 } }],
		})
		expect(result.ok).toBe(false)
		expect((await kora.findById('seats', 's1'))?.takenBy ?? null).toBeNull()
	})

	test('a scoped transaction cannot cascade a delete outside its scope', async () => {
		const kora = (await serverOn(kind)).getKoraContext()
		await kora.apply({
			collection: 'seats',
			type: 'insert',
			recordId: 's1',
			data: { label: 'A1', org: 'a' },
		})
		await kora.apply({
			collection: 'notes',
			type: 'insert',
			recordId: 'n1',
			data: { body: 'b', seatId: 's1', org: 'b' },
		})
		const scope = { seats: { org: 'a' }, notes: { org: 'a' } }
		const result = await kora.transaction(
			async () => [{ collection: 'seats', type: 'delete', recordId: 's1' }],
			{ scope },
		)
		expect(result).toMatchObject({ ok: false, code: 'RESTRICTED' })
		expect(await kora.findById('seats', 's1')).not.toBeNull()
		expect(await kora.findById('notes', 'n1')).not.toBeNull()
	})

	test('a child moved to another parent in the same transaction survives the cascade', async () => {
		const kora = (await serverOn(kind)).getKoraContext()
		await kora.apply({ collection: 'seats', type: 'insert', recordId: 's1', data: { label: 'A1' } })
		await kora.apply({ collection: 'seats', type: 'insert', recordId: 's2', data: { label: 'A2' } })
		await kora.apply({
			collection: 'notes',
			type: 'insert',
			recordId: 'n1',
			data: { body: 'b', seatId: 's1' },
		})
		const result = await kora.transaction(async () => [
			{ collection: 'notes', type: 'update', recordId: 'n1', data: { seatId: 's2' } },
			{ collection: 'seats', type: 'delete', recordId: 's1' },
		])
		expect(result.ok).toBe(true)
		expect(await kora.findById('seats', 's1')).toBeNull()
		expect((await kora.findById('notes', 'n1'))?.seatId).toBe('s2')
	})

	test('a child the batch points at a record it deletes under restrict refuses the batch', async () => {
		const kora = (await serverOn(kind)).getKoraContext()
		await kora.apply({ collection: 'seats', type: 'insert', recordId: 's1', data: { label: 'A1' } })
		const result = await kora.transaction(async () => [
			{ collection: 'tags', type: 'insert', recordId: 't1', data: { name: 'vip', seatId: 's1' } },
			{ collection: 'seats', type: 'delete', recordId: 's1' },
		])
		expect(result).toMatchObject({ ok: false, code: 'REFERENTIAL_INTEGRITY' })
		expect(await kora.findById('seats', 's1')).not.toBeNull()
		expect(await kora.findById('tags', 't1')).toBeNull()
	})

	test('a batch that removes every child and then their parent passes restrict', async () => {
		const kora = (await serverOn(kind)).getKoraContext()
		await kora.apply({ collection: 'seats', type: 'insert', recordId: 's1', data: { label: 'A1' } })
		await kora.apply({
			collection: 'tags',
			type: 'insert',
			recordId: 't1',
			data: { name: 'a', seatId: 's1' },
		})
		await kora.apply({
			collection: 'tags',
			type: 'insert',
			recordId: 't2',
			data: { name: 'b', seatId: 's1' },
		})
		expect((await kora.apply({ collection: 'seats', type: 'delete', recordId: 's1' })).ok).toBe(
			false,
		)
		const result = await kora.transaction(async () => [
			{ collection: 'tags', type: 'delete', recordId: 't1' },
			{ collection: 'tags', type: 'update', recordId: 't2', data: { seatId: null } },
			{ collection: 'seats', type: 'delete', recordId: 's1' },
		])
		expect(result.ok).toBe(true)
		expect(await kora.findById('seats', 's1')).toBeNull()
	})

	test('blob owners a refused decision added are taken back', async () => {
		const { server, store } = await serverAndStore(kind)
		const kora = server.getKoraContext()
		const hash = 'b'.repeat(64)
		const result = await kora.transaction(
			async () => [
				{
					collection: 'files',
					type: 'insert',
					recordId: 'f1',
					data: { org: 'a', content: { hash, size: 3 } },
				},
				{ collection: 'files', type: 'insert', recordId: 'f2', data: { org: 'a', content: 42 } },
			],
			{ scope: { files: { org: 'a' } } },
		)
		expect(result.ok).toBe(false)
		expect((await store.getBlobOwners?.([hash]))?.get(hash) ?? []).toEqual([])
	})

	test('a write started inside a decision is refused instead of waiting for itself', async () => {
		const kora = (await serverOn(kind)).getKoraContext()
		let inner: unknown = null
		const result = await kora.transaction(async (tx) => {
			inner = await kora
				.apply({ collection: 'seats', type: 'insert', recordId: 's9', data: { label: 'Z' } })
				.catch((error: unknown) => error)
			return tx.reject('DONE', 'done')
		})
		expect(result.ok).toBe(false)
		expect(inner).toMatchObject({ code: 'ROUTE_TRANSACTION_REENTRY' })
	})

	test('roleOf reads the membership index; since changes with the role', async () => {
		const server = await serverOn(kind, true)
		const kora = server.getKoraContext()
		await kora.apply({
			collection: 'docs',
			type: 'insert',
			recordId: 'd1',
			data: { title: 'Plan', ownerId: 'ann' },
		})
		let seen: unknown[] = []
		const read = async (user: string) => {
			await kora.transaction(async (tx) => {
				seen = [await tx.roleOf(user, ['docs', 'd1'])]
				return []
			})
			return seen[0] as { role: string; source: string; since: number } | null
		}
		const owner = await read('ann')
		expect(owner).toMatchObject({ role: 'manage', source: 'owner' })
		expect(await read('bob')).toBeNull()
		await server.access.grant({ userId: 'bob', group: ['docs', 'd1'], role: 'view' })
		const first = await read('bob')
		expect(first).toMatchObject({ role: 'view', source: 'membership' })
		await server.access.grant({ userId: 'bob', group: ['docs', 'd1'], role: 'edit' })
		const second = await read('bob')
		expect(second?.role).toBe('edit')
		expect(second?.since).not.toBe(first?.since)
	})

	test('a membership grant commits with the other writes of the transaction', async () => {
		const server = await serverOn(kind, true)
		const kora = server.getKoraContext()
		await kora.apply({
			collection: 'docs',
			type: 'insert',
			recordId: 'd1',
			data: { title: 'Plan', ownerId: 'ann' },
		})
		const result = await kora.transaction(async (tx) => {
			if (await tx.roleOf('bob', ['docs', 'd1']))
				return tx.reject('ALREADY_MEMBER', 'Already a member.')
			return [
				...(await server.access.prepareGrant(tx, {
					userId: 'bob',
					group: ['docs', 'd1'],
					role: 'edit',
				})),
				{ collection: 'docs', type: 'update', recordId: 'd1', data: { title: 'Shared plan' } },
			]
		})
		expect(result.ok).toBe(true)
		expect(await server.access.roleOf('bob', ['docs', 'd1'])).toMatchObject({ role: 'edit' })
		expect((await kora.findById('docs', 'd1'))?.title).toBe('Shared plan')
		const again = await kora.transaction(async (tx) =>
			(await tx.roleOf('bob', ['docs', 'd1']))
				? tx.reject('ALREADY_MEMBER', 'Already a member.')
				: [],
		)
		expect(again).toMatchObject({ ok: false, code: 'ALREADY_MEMBER' })
		expect(
			await kora.transaction(async (tx) =>
				server.access.prepareRevoke(tx, { userId: 'bob', group: ['docs', 'd1'] }),
			),
		).toMatchObject({ ok: true })
		expect(await server.access.roleOf('bob', ['docs', 'd1'])).toBeNull()
	})
})

test('SQLite: a commit from another connection during a decision makes it decide again', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'kora-tx-2conn-'))
	dirs.push(dir)
	const filename = join(dir, 'server.db')
	const storeA = createSqliteServerStore({ filename, nodeId: 'server-a' })
	await storeA.setSchema(schema)
	const storeB = createSqliteServerStore({ filename, nodeId: 'server-b' })
	await storeB.setSchema(schema)
	const a = createKoraServer({ store: storeA })
	const b = createKoraServer({ store: storeB })
	servers.push(a, b)
	await a
		.getKoraContext()
		.apply({ collection: 'seats', type: 'insert', recordId: 's1', data: { label: 'A1' } })

	let release: () => void = () => {}
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	let decisions = 0
	const taking = a.getKoraContext().transaction(async (tx) => {
		decisions += 1
		const seat = await tx.findById('seats', 's1')
		if (decisions === 1) await gate
		if (!seat || seat.takenBy) return tx.reject('TAKEN', 'Taken.')
		return [{ collection: 'seats', type: 'update', recordId: 's1', data: { takenBy: 'ann' } }]
	})
	await new Promise((resolve) => setTimeout(resolve, 20))
	// The other process takes the seat while the first decision waits.
	expect(
		(
			await b
				.getKoraContext()
				.apply({ collection: 'seats', type: 'update', recordId: 's1', data: { takenBy: 'bob' } })
		).ok,
	).toBe(true)
	release()
	expect(await taking).toMatchObject({ ok: false, code: 'TAKEN' })
	expect(decisions).toBe(2)
})

/** A store whose transactions decide twice, as SQLite does after another connection's commit. */
class DecidingTwiceStore extends MemoryServerStore {
	betweenAttempts: (() => Promise<void>) | null = null
	override async transact(
		run: Parameters<MemoryServerStore['transact']>[0],
	): ReturnType<MemoryServerStore['transact']> {
		await super.transact(async (store) => {
			await run(store)
			return null
		})
		await this.betweenAttempts?.()
		return super.transact(run)
	}
}

test('state from an earlier attempt of a decision does not carry over (applyConditional, backfill)', async () => {
	const store = new DecidingTwiceStore()
	await store.setSchema(accessSchema, { accessRulesEnforced: true })
	const server = createKoraServer({
		store,
		experimentalAccessRules: true,
		accessSweepIntervalMs: 0,
	})
	servers.push(server)
	const kora = server.getKoraContext()
	await kora.apply({
		collection: 'docs',
		type: 'insert',
		recordId: 'anchor',
		data: { title: 'A', ownerId: 'ann' },
	})

	// The idempotency anchor is gone by the second attempt: the set commits.
	store.betweenAttempts = async () => {
		await store.applyRemoteOperation(
			makeOp('device-x', 1, { type: 'delete', collection: 'docs', recordId: 'anchor', data: null }),
		)
	}
	const conditional = await kora.applyConditional({
		collection: 'docs',
		id: 'd9',
		also: [
			{
				collection: 'docs',
				type: 'insert',
				recordId: 'd9',
				data: { title: 'New', ownerId: 'ann' },
			},
		],
		idempotencyKey: { collection: 'docs', id: 'anchor' },
	})
	expect(conditional).toMatchObject({ ok: true, idempotent: false })
	expect(await kora.findById('docs', 'd9')).not.toBeNull()

	// The group appears by the second attempt: the membership is granted, not reported missing.
	store.betweenAttempts = async () => {
		await store.applyRemoteOperation(
			makeOp('device-x', 2, {
				collection: 'docs',
				recordId: 'late',
				data: { title: 'L', ownerId: 'ann' },
			}),
		)
	}
	const result = await server.access.backfill([
		{ userId: 'bob', group: ['docs', 'late'], role: 'view' },
	])
	expect(result).toMatchObject({ granted: 1, missingGroups: [] })
})
