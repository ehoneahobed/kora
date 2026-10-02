/**
 * RT-38 repro (Phase 2 red team, 2026-10-02): node rotation (RT-21) re-authors one
 * user's unsynced writes and uploads them under the NEXT signed-in user's identity.
 *
 * Without `store.namespaceByAuthUser` (the default), users who sign in one after the
 * other on a device share one local database and one node id. The node is claimed by
 * the first user, so the second user's handshake is refused with NODE_ID_CLAIMED; the
 * engine then rotates to a fresh node id and re-queues EVERY own operation above the
 * acknowledged prefix (`rotateNodeIdentity`), whoever wrote it. Alice's offline edits
 * are uploaded on Bob's session: the server authorizes them against Bob's grant, runs
 * the app validator with Bob's auth context, and records Bob as their author. A write
 * Alice could not make (or one she made as herself) becomes Bob's.
 *
 * Asserts the CORRECT behaviour (fails today): an operation written while Alice was
 * signed in is never submitted on another principal's session.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { KoraSyncServer, MemoryServerStore, TokenAuthProvider } from '@korajs/server'
import type { ServerTransport } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { TestDevice } from '../../src/test-device'
import type { TestServer } from '../../src/test-server'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { body: t.string(), team: t.string() } } },
})

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const fn of cleanup.reverse()) await fn()
	cleanup = []
})

describe('RT-38: rotation uploads the previous user unsynced writes as the next user', () => {
	test("Alice's offline note is not submitted on Bob's session", async () => {
		const store = new MemoryServerStore()
		await store.setSchema(schema)
		const submittedBy = new Map<string, string>()
		const server = new KoraSyncServer({
			store,
			relayRetransmitIntervalMs: 0,
			deliveryPollIntervalMs: 0,
			// Both users are members of team t1.
			auth: new TokenAuthProvider({
				validate: async (token) => ({ userId: token, scopes: { notes: { team: 't1' } } }),
			}),
			validateOperation: async (op, ctx) => {
				submittedBy.set(String(op.data?.body ?? op.id), String(ctx.auth?.userId))
				return { action: 'accept' }
			},
		})
		cleanup.push(() => server.stop())
		const tmp = mkdtempSync(join(tmpdir(), 'rt38-'))
		cleanup.push(() => rmSync(tmp, { recursive: true, force: true }))

		let token = 'alice'
		const viaToken = {
			handleConnection(transport: ServerTransport): string {
				return server.handleConnection({
					send: (m: SyncMessage) => transport.send(m),
					onMessage: (h) =>
						transport.onMessage((m: SyncMessage) =>
							h(m.type === 'handshake' ? ({ ...m, authToken: token } as SyncMessage) : m),
						),
					onClose: (h) => transport.onClose(h),
					onError: (h) => transport.onError(h),
					isConnected: () => transport.isConnected(),
					close: (c, r) => transport.close(c, r),
				})
			},
		} as unknown as TestServer
		const device = new TestDevice({
			name: 'shared-laptop',
			schema,
			server: viaToken,
			tmpDir: tmp,
			createTransportPair: () => {
				const pair = createServerTransportPair()
				return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
			},
		})
		await device.open()
		cleanup.push(() => device.close())

		// Alice signs in and syncs: the node id is claimed by Alice.
		await device.sync()
		await device.collection('notes').insert({ body: 'alice synced', team: 't1' })
		await device.sync()
		expect(submittedBy.get('alice synced')).toBe('alice')

		// Alice goes offline, writes, signs out. Bob signs in on the same laptop.
		await device.disconnect()
		await device.collection('notes').insert({ body: 'alice offline draft', team: 't1' })
		token = 'bob'
		for (let i = 0; i < 4; i++) {
			await device.disconnect()
			await device.sync()
		}

		// Alice's draft must not have been submitted as Bob's write.
		expect(submittedBy.get('alice offline draft')).not.toBe('bob')
	})
})
