/**
 * RT-52 repro (Phase 2 red team round 3, 2026-10-02): the RT-42 residual window ("writes
 * issued in the same instant as a sign-in") is as long as any auth-driven reconnect
 * that is already running.
 *
 * `AuthSyncCoordinator` serializes auth changes: a change that arrives while a run is in
 * flight is only marked `pending`. The run calls `refreshPrincipal()` first and then
 * `engine.reconnect()`, which awaits the credential fetch and `transport.connect()`
 * (10 s connect timeout on WebSocket; longer when the auth client retries). A user switch
 * during that time is not applied until the run ends, so every write the new user makes
 * meanwhile is authored under the PREVIOUS user's node: held while the new user is
 * signed in, and uploaded as the previous user when they sign in again.
 *
 * Here Alice's token refresh starts a reconnect on a slow network; Bob signs in (the
 * auth binding reports it) and writes.
 *
 * Asserts the CORRECT behaviour (fails today): Bob's write is never submitted as Alice.
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
import { AuthSyncCoordinator } from '../../../../kora/src/auth-sync-coordinator'
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

describe('RT-52: a user switch waits behind an in-flight auth reconnect', () => {
	test("Bob's write made after his sign-in was reported is never submitted as Alice", async () => {
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
		const tmp = mkdtempSync(join(tmpdir(), 'rt52-'))
		cleanup.push(() => rmSync(tmp, { recursive: true, force: true }))
		const auth = { user: 'alice' }
		const viaToken = {
			handleConnection(transport: ServerTransport): string {
				return server.handleConnection({
					send: (m: SyncMessage) => transport.send(m),
					onMessage: (h) =>
						transport.onMessage((m: SyncMessage) =>
							h(m.type === 'handshake' ? ({ ...m, authToken: auth.user } as SyncMessage) : m),
						),
					onClose: (h) => transport.onClose(h),
					onError: (h) => transport.onError(h),
					isConnected: () => transport.isConnected(),
					close: (c, r) => transport.close(c, r),
				})
			},
		} as unknown as TestServer
		// A network that is slow to connect (the WebSocket transport waits up to 10 s).
		let slowNetwork: { release: () => void } | null = null
		const device = new TestDevice({
			name: 'shared-laptop',
			schema,
			server: viaToken,
			tmpDir: tmp,
			principal: () => auth.user,
			createTransportPair: () => {
				const pair = createServerTransportPair()
				const client = pair.client as unknown as SyncTransport
				const connect = client.connect.bind(client)
				client.connect = async (url, options) => {
					if (slowNetwork) {
						await new Promise<void>((resolve) => {
							const previous = slowNetwork
							slowNetwork = {
								release: () => {
									previous?.release()
									resolve()
								},
							}
						})
					}
					return connect(url, options)
				}
				return { client, serverTransport: pair.server }
			},
		})
		await device.open()
		cleanup.push(() => device.close())
		await device.sync()
		await device.collection('notes').insert({ body: 'alice synced', team: 't1' })
		await device.sync()
		expect(submittedBy.get('alice synced')).toBe('alice')
		const engine = device.getSyncEngine()
		if (!engine) throw new Error('no engine')

		// The app's auth binding, as createApp wires it for `sync.authClient`.
		const coordinator = new AuthSyncCoordinator(() => engine, {
			auth: async () => ({ token: auth.user }),
			resolveSyncState: async () => ({
				state: 'authenticated',
				userId: auth.user,
				token: auth.user,
			}),
		})
		// Alice's token is refreshed while the network is slow: the coordinator reconnects.
		slowNetwork = { release: () => {} }
		coordinator.scheduleReconnect()
		await new Promise((resolve) => setTimeout(resolve, 50))

		// Alice signs out, Bob signs in; the auth binding reports it, and Bob writes.
		auth.user = 'bob'
		coordinator.scheduleReconnect()
		await new Promise((resolve) => setTimeout(resolve, 50))
		await device.collection('notes').insert({ body: 'bob after sign-in', team: 't1' })

		// The network recovers; later, Alice signs back in on this laptop.
		const network = slowNetwork as { release: () => void } | null
		slowNetwork = null
		network?.release()
		await new Promise((resolve) => setTimeout(resolve, 300))
		for (let i = 0; i < 3; i++) {
			await device.disconnect()
			await device.sync()
		}
		auth.user = 'alice'
		await device.authChanged()
		for (let i = 0; i < 3; i++) {
			await device.disconnect()
			await device.sync()
		}

		expect(submittedBy.get('bob after sign-in') ?? null).not.toBe('alice')
	}, 60_000)
})
