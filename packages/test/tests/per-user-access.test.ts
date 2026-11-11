/**
 * The public harness tests access rules across users the way an app would: a TestServer with
 * `auth: true` and a TestDevice per signed-in `user`, with no framework internals.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, owner, t } from '@korajs/core'
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
