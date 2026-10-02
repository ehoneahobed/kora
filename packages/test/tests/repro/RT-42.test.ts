/**
 * RT-42 repro (Phase 2 red team round 2, 2026-10-02): unsynced writes are bound to a
 * NODE, not to the principal that made them. The engine learns which principal owns a
 * node only at an accepted handshake, so a write made before that handshake belongs to
 * whoever handshakes first as that node.
 *
 * 1. Shared database (no namespaceByAuthUser, the default). Alice synced on node NA.
 *    Bob signs in and writes immediately (offline, or before the reconnect handshake
 *    completes): his write is authored under NA. Bob's handshake as NA is refused
 *    (NODE_ID_CLAIMED), NA was accepted before, so ALL of NA's unsynced writes are held
 *    for Alice, Bob's included. Bob's write never syncs while he is signed in. When
 *    Alice signs back in, Bob's write is uploaded on Alice's session, authorized and
 *    validated as Alice and attributed to her.
 * 2. Fresh database: Alice writes offline and never syncs (the node was never accepted),
 *    signs out; Bob signs in: Bob's handshake claims the node and Alice's writes are
 *    uploaded as Bob's.
 *
 * Asserts the CORRECT behaviour (fails today): a write is only ever submitted on the
 * session of the principal that made it, and Bob's own write syncs while he is signed in.
 *
 * The device knows who is signed in, as an app with an auth binding does (`createApp`
 * with `sync.authClient`, modelled by TestDevice's `principal` and `authChanged()`, which
 * the app's auth subscription triggers). A client that is never told who is signed in
 * cannot tell two users' writes apart before the server answers (documented residual).
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

async function setup(name: string) {
	const store = new MemoryServerStore()
	await store.setSchema(schema)
	const submittedBy = new Map<string, string>()
	const server = new KoraSyncServer({
		store,
		relayRetransmitIntervalMs: 0,
		deliveryPollIntervalMs: 0,
		auth: new TokenAuthProvider({
			validate: async (token) => ({ userId: token, scopes: { notes: { team: 't1' } } }),
		}),
		validateOperation: async (op, ctx) => {
			submittedBy.set(String(op.data?.body ?? op.id), String(ctx.auth?.userId))
			return { action: 'accept' }
		},
	})
	cleanup.push(() => server.stop())
	const tmp = mkdtempSync(join(tmpdir(), 'rt42-'))
	cleanup.push(() => rmSync(tmp, { recursive: true, force: true }))
	const auth = { token: 'alice' }
	const viaToken = {
		handleConnection(transport: ServerTransport): string {
			return server.handleConnection({
				send: (m: SyncMessage) => transport.send(m),
				onMessage: (h) =>
					transport.onMessage((m: SyncMessage) =>
						h(m.type === 'handshake' ? ({ ...m, authToken: auth.token } as SyncMessage) : m),
					),
				onClose: (h) => transport.onClose(h),
				onError: (h) => transport.onError(h),
				isConnected: () => transport.isConnected(),
				close: (c, r) => transport.close(c, r),
			})
		},
	} as unknown as TestServer
	const device = new TestDevice({
		name,
		schema,
		server: viaToken,
		tmpDir: tmp,
		principal: () => auth.token,
		createTransportPair: () => {
			const pair = createServerTransportPair()
			return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
		},
	})
	await device.open()
	cleanup.push(() => device.close())
	const cycle = async (n = 4): Promise<void> => {
		for (let i = 0; i < n; i++) {
			await device.disconnect()
			await device.sync()
		}
	}
	return { device, auth, submittedBy, cycle }
}

describe('RT-42: unsynced writes are bound to a node, not to the principal that wrote them', () => {
	test("Bob's write made right after sign-in is held for Alice, then uploaded as Alice", async () => {
		const { device, auth, submittedBy, cycle } = await setup('shared-laptop')
		await device.sync()
		await device.collection('notes').insert({ body: 'alice synced', team: 't1' })
		await device.sync()
		expect(submittedBy.get('alice synced')).toBe('alice')

		// Alice signs out; Bob signs in and writes before his first handshake completes.
		await device.disconnect()
		auth.token = 'bob'
		await device.authChanged()
		await device.collection('notes').insert({ body: 'bob first note', team: 't1' })
		await cycle()
		const bobSeesHeld = device.getSyncEngine()?.getStatus().heldOperations ?? 0

		// Alice signs back in on the same laptop.
		auth.token = 'alice'
		await device.authChanged()
		await cycle()

		expect({
			bobNoteSyncedWhileBobSignedIn: bobSeesHeld === 0,
			bobNoteSubmittedBy: submittedBy.get('bob first note') ?? null,
		}).toEqual({ bobNoteSyncedWhileBobSignedIn: true, bobNoteSubmittedBy: 'bob' })
	})

	test("a never-synced database: Alice's offline writes are uploaded as Bob's", async () => {
		const { device, auth, submittedBy, cycle } = await setup('fresh-laptop')
		// Alice installs the app offline, writes, signs out before ever connecting.
		await device.collection('notes').insert({ body: 'alice offline only', team: 't1' })
		auth.token = 'bob'
		await device.authChanged()
		await cycle()
		expect(submittedBy.get('alice offline only') ?? null).not.toBe('bob')
	})
})
