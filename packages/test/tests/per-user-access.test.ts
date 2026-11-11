/**
 * The public harness tests access rules across users the way an app would: a TestServer with
 * `auth: true` and a TestDevice per signed-in `user`, with no framework internals.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, member, owner, t } from '@korajs/core'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncTransport } from '@korajs/sync'
import { afterEach, expect, test } from 'vitest'
import { TestDevice } from '../src/test-device'
import { TestServer } from '../src/test-server'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: {
			fields: { body: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: owner('ownerId'), write: owner('ownerId') },
		},
	},
})

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const fn of cleanup.reverse()) await fn()
	cleanup = []
})

test('each signed-in user receives only what the access rules give them', async () => {
	const server = new TestServer(schema, { auth: true })
	await server.ready
	const tmpDir = mkdtempSync(join(tmpdir(), 'per-user-access-'))
	cleanup.push(() => rmSync(tmpDir, { recursive: true, force: true }))
	const device = (name: string, user: string): TestDevice => {
		const created = new TestDevice({
			name,
			schema,
			server,
			tmpDir,
			user,
			createTransportPair: () => {
				const pair = createServerTransportPair()
				return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
			},
		})
		cleanup.push(() => created.close())
		return created
	}

	const aliceLaptop = device('alice-laptop', 'alice')
	const alicePhone = device('alice-phone', 'alice')
	const bobLaptop = device('bob-laptop', 'bob')
	for (const each of [aliceLaptop, alicePhone, bobLaptop]) await each.open()

	await aliceLaptop.collection('notes').insert({ body: 'alice only' })
	await bobLaptop.collection('notes').insert({ body: 'bob only' })
	for (let round = 0; round < 3; round += 1)
		for (const each of [aliceLaptop, bobLaptop, alicePhone]) await each.sync()

	const bodies = async (each: TestDevice): Promise<string[]> =>
		((await each.collection('notes').where({}).exec()) as Array<{ body: string }>)
			.map((note) => note.body)
			.sort()
	expect(await bodies(alicePhone)).toEqual(['alice only'])
	expect(await bodies(bobLaptop)).toEqual(['bob only'])
	expect(await bodies(aliceLaptop)).toEqual(['alice only'])
})

test('a collaborator granted access receives the record, and loses it when removed', async () => {
	const shared = defineSchema({
		version: 1,
		access: {
			memberships: 'members',
			roles: ['view', 'edit'],
			groups: { boards: { owner: 'ownerId', role: 'edit' } },
		},
		collections: {
			members: { fields: { userId: t.string(), group: t.string(), role: t.string() } },
			boards: {
				fields: { title: t.string(), ownerId: t.string().stamp('userId') },
				access: {
					read: member('id'),
					create: owner('ownerId'),
					update: member('id', 'edit'),
					delete: member('id', 'edit'),
				},
			},
		},
	})
	const server = new TestServer(shared, { auth: true, accessSweepIntervalMs: 0 })
	await server.ready
	const tmpDir = mkdtempSync(join(tmpdir(), 'per-user-grant-'))
	cleanup.push(() => rmSync(tmpDir, { recursive: true, force: true }))
	const device = (name: string, user: string): TestDevice => {
		const created = new TestDevice({
			name,
			schema: shared,
			server,
			tmpDir,
			user,
			createTransportPair: () => {
				const pair = createServerTransportPair()
				return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
			},
		})
		cleanup.push(() => created.close())
		return created
	}
	const alice = device('alice', 'alice')
	const bob = device('bob', 'bob')
	await alice.open()
	await bob.open()
	const board = (await alice.collection('boards').insert({ title: 'Roadmap' })) as { id: string }
	await alice.sync()
	expect(await alice.getRejectedOperations()).toEqual([])
	await bob.sync()
	const titles = async (each: TestDevice): Promise<string[]> =>
		((await each.collection('boards').where({}).exec()) as Array<{ title: string }>).map(
			(row) => row.title,
		)
	expect(await titles(bob)).toEqual([])

	await server.access.grant({ userId: 'bob', group: ['boards', board.id], role: 'view' })
	for (let round = 0; round < 3; round += 1) await bob.sync()
	expect(await titles(bob)).toEqual(['Roadmap'])

	await server.access.revoke({ userId: 'bob', group: ['boards', board.id] })
	for (let round = 0; round < 3; round += 1) await bob.sync()
	expect(await titles(bob)).toEqual([])
})
