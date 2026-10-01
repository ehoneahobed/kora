import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { KoraSyncServer, MemoryServerStore } from '@korajs/server'
import type { ServerTransport } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { TestDevice } from '../../src/test-device'
import type { TestServer } from '../../src/test-server'

/**
 * SRV-2 repro: server visibility is judged per-operation against the op's own
 * data (falling back to the record's CURRENT row only for missing fields). A record
 * that moves INTO a client's scope delivers the moving update but not its insert, so
 * the client never materializes the record.
 */
const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), owner: t.string() } } },
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.()
})

/** A scoped KoraSyncServer; each device authenticates as its own name. */
async function scopedNetwork(names: string[]) {
	const store = new MemoryServerStore()
	await store.setSchema(schema)
	const sync = new KoraSyncServer({
		store,
		auth: {
			authenticate: async (token: string) =>
				token === 'admin'
					? { userId: 'admin', scopes: { todos: {} } }
					: { userId: token, scopes: { todos: { owner: token } } },
		},
	})
	const tmp = mkdtempSync(join(tmpdir(), 'kora-srv2-'))
	const devices: Record<string, TestDevice> = {}
	for (const name of names) {
		const fakeServer = {
			handleConnection(transport: ServerTransport): string {
				// Inject the device's identity as its auth token on handshake.
				const wrapped: ServerTransport = {
					send: (m) => transport.send(m),
					onMessage: (h) =>
						transport.onMessage((m: SyncMessage) =>
							h(m.type === 'handshake' ? ({ ...m, authToken: name } as SyncMessage) : m),
						),
					onClose: (h) => transport.onClose(h),
					onError: (h) => transport.onError(h),
					isConnected: () => transport.isConnected(),
					close: (c, r) => transport.close(c, r),
				}
				return sync.handleConnection(wrapped)
			},
		} as unknown as TestServer
		const device = new TestDevice({
			name,
			schema,
			server: fakeServer,
			tmpDir: tmp,
			createTransportPair: () => {
				const pair = createServerTransportPair()
				return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
			},
		})
		await device.open()
		devices[name] = device
	}
	cleanups.push(async () => {
		for (const d of Object.values(devices)) await d.close()
		await sync.stop()
		rmSync(tmp, { recursive: true, force: true })
	})
	return { store, devices }
}

async function settle(ds: TestDevice[], rounds = 3): Promise<void> {
	for (let i = 0; i < rounds; i++) for (const d of ds) await d.sync()
}

describe('SRV-2 visibility judged per op / current state', () => {
	test('record reassigned INTO a client scope is fully delivered (insert + update)', async () => {
		const { devices } = await scopedNetwork(['admin', 'alice', 'bob'])
		const { admin, alice, bob } = devices as Record<string, TestDevice>
		const rec = await bob.collection('todos').insert({ title: 'handover', owner: 'bob' })
		await settle([bob, admin, alice])
		expect(await alice.collection('todos').findById(rec.id)).toBeNull()

		await admin.collection('todos').update(rec.id, { owner: 'alice' })
		await settle([admin, alice, bob])

		const seen = await alice.collection('todos').findById(rec.id)
		expect(seen).not.toBeNull()
		expect(seen?.title).toBe('handover')
		expect(seen?.owner).toBe('alice')
	}, 30000)

	test('client that first connects after the move-in still receives the record', async () => {
		const { devices } = await scopedNetwork(['admin', 'alice', 'bob'])
		const { admin, alice, bob } = devices as Record<string, TestDevice>
		const rec = await bob.collection('todos').insert({ title: 'late', owner: 'bob' })
		await settle([bob, admin])
		await admin.collection('todos').update(rec.id, { owner: 'alice' })
		await settle([admin])
		await settle([alice]) // full initial sync from delivery seq 0
		const seen = await alice.collection('todos').findById(rec.id)
		expect(seen?.title).toBe('late')
	}, 30000)
})
