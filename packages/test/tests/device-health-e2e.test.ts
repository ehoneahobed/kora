import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { createSqliteServerStore } from '@korajs/server'
import type { ServerStore, ServerTransport } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { TestDevice, TestServer } from '../src/index'

/**
 * Devices report their own sync health (counts, never data) to a server that records it, and
 * the server's insights show it. A device on an older schema receives an operation for a
 * collection it doesn't know yet, sets it aside, and says so.
 */
const older = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})
const newer = defineSchema({
	version: 2,
	collections: {
		todos: { fields: { title: t.string() } },
		notes: { fields: { body: t.string() } },
	},
})

let dir: string
let server: TestServer<ServerStore> | null = null
const devices: TestDevice[] = []
const sent: SyncMessage[] = []

afterEach(async () => {
	for (const device of devices.splice(0)) await device.disconnect().catch(() => undefined)
	await server?.close()
	server = null
	sent.length = 0
	rmSync(dir, { recursive: true, force: true })
})

async function device(name: string, schema: typeof older): Promise<TestDevice> {
	const created = new TestDevice({
		name,
		schema,
		server: {
			handleConnection: (transport: ServerTransport) => server!.handleConnection(transport),
		},
		tmpDir: dir,
		createTransportPair: () => {
			const pair = createServerTransportPair()
			const client = pair.client as unknown as SyncTransport
			const send = client.send.bind(client)
			client.send = (message: SyncMessage) => {
				sent.push(message)
				return send(message)
			}
			return { client, serverTransport: pair.server }
		},
	})
	devices.push(created)
	await created.open()
	return created
}

describe('device health reporting', () => {
	test('a device reports what it set aside, and the server insights count it', async () => {
		dir = mkdtempSync(join(tmpdir(), 'kora-device-health-'))
		server = new TestServer(newer, {
			store: createSqliteServerStore({ filename: join(dir, 'server.db'), nodeId: 'server-node' }),
			supportedSchemaVersions: { min: 1, max: 2 },
		})
		await server.ready
		const writer = await device('writer', newer)
		const reader = await device('reader', older)
		await reader.sync()
		await writer.sync()
		await writer.collection('notes').insert({ body: 'only the newer schema knows notes' })
		await writer.sync()
		await reader.sync()

		await expect
			.poll(async () => (await server!.store.getStoreInsights!(Date.now())).devices.health, {
				timeout: 20_000,
				interval: 250,
			})
			.toMatchObject({
				reporting: 2,
				withQuarantined: 1,
				quarantinedOperations: 1,
				blocked: 0,
				storageDegraded: 0,
			})

		const statuses = sent.filter((message) => message.type === 'device-status')
		// Counts and a code only: nothing that names an operation, record or value.
		for (const status of statuses) {
			expect(Object.keys(status).sort()).toEqual(
				expect.arrayContaining([
					'applyBlocked',
					'heldOperations',
					'localDurability',
					'messageId',
					'pendingOperations',
					'quarantined',
					'type',
				]),
			)
			expect(JSON.stringify(status)).not.toContain('only the newer schema')
		}
	}, 30_000)

	test('a device never sends its status to a server that does not record it', async () => {
		dir = mkdtempSync(join(tmpdir(), 'kora-device-health-'))
		// The memory store keeps no device activity, so the server doesn't ask for status.
		server = new TestServer(older) as unknown as TestServer<ServerStore>
		await server.ready
		const one = await device('one', older)
		await one.sync()
		await one.collection('todos').insert({ title: 'a' })
		await one.sync()
		await new Promise((resolve) => setTimeout(resolve, 6_000))
		expect(sent.some((message) => message.type === 'device-status')).toBe(false)
	}, 20_000)
})
