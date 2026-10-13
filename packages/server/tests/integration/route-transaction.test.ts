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
			fields: { label: t.string(), takenBy: t.string().optional(), count: t.number().default(0) },
		},
		notes: { fields: { body: t.string(), seatId: t.string().optional() } },
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
})
