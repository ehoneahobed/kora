/**
 * RT-50 repro (Phase 2 red team round 3, 2026-10-02): `Store.bindPrincipal()` binds an
 * UNBOUND current node to whichever user is signed in first, without asking who owns
 * it (RT-42 fix). Every database created before the fix has only unbound nodes. On a
 * shared multi-user device that is upgraded while Bob has unsynced writes on his node,
 * the first sign-in after the upgrade (Alice) binds Bob's node to Alice locally:
 *
 * - the server refuses it for Alice (NODE_ID_CLAIMED: Bob claimed it), so it is held,
 *   and nothing ever corrects the local binding from the server's answer;
 * - when Bob signs in, the node "belongs to another principal" (Alice) locally, so it
 *   is never uploaded, adopted or re-tried on Bob's session either.
 *
 * Bob's pre-upgrade unsynced write is stranded forever (reported as heldOperations,
 * so `deleteDatabase` refuses without `force`, but it never reaches the server).
 *
 * Second case, same root cause: a pre-upgrade database that never synced (Alice wrote
 * offline). The first user to sign in after the upgrade (Bob) gets Alice's node bound
 * to him, and her writes are uploaded as Bob: the RT-42 case "a database that never
 * synced does not hand one user's offline writes to the next user" is still open for
 * every database created before the fix.
 *
 * Asserts the CORRECT behaviour (fails today): Bob's pre-upgrade write is uploaded as
 * Bob once he signs in after the upgrade, nothing stays held, and Alice's pre-upgrade
 * offline write is never submitted as Bob.
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

async function setup() {
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
	const tmp = mkdtempSync(join(tmpdir(), 'rt50-'))
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
	const mk = (principal?: () => string | null) =>
		new TestDevice({
			name: 'family-laptop',
			schema,
			server: viaToken,
			tmpDir: tmp,
			...(principal ? { principal } : {}),
			createTransportPair: () => {
				const pair = createServerTransportPair()
				return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
			},
		})
	const cycle = async (device: TestDevice, n = 4): Promise<void> => {
		for (let i = 0; i < n; i++) {
			await device.disconnect()
			await device.sync()
		}
	}

	return { auth, submittedBy, mk, cycle }
}

describe('RT-50: an unbound node is bound to the first user who signs in after the upgrade', () => {
	test("Bob's pre-upgrade unsynced write reaches the server as Bob", async () => {
		const { auth, submittedBy, mk, cycle } = await setup()
		// Before the upgrade (no principal binding, the RT-38 behaviour): Alice and Bob
		// share the laptop's database; Bob ends with one write that never synced.
		const before = mk()
		await before.open()
		await before.sync()
		await before.collection('notes').insert({ body: 'alice synced', team: 't1' })
		await before.sync()
		await before.disconnect()
		auth.token = 'bob'
		await cycle(before)
		await before.collection('notes').insert({ body: 'bob synced', team: 't1' })
		await before.sync()
		expect(submittedBy.get('bob synced')).toBe('bob')
		await before.disconnect()
		await before.collection('notes').insert({ body: 'bob offline before upgrade', team: 't1' })
		await before.close()

		// The app is upgraded. Alice is the first to sign in.
		auth.token = 'alice'
		const after = mk(() => auth.token)
		await after.open()
		cleanup.push(() => after.close())
		await cycle(after)
		await after.collection('notes').insert({ body: 'alice after upgrade', team: 't1' })
		await cycle(after)
		expect(submittedBy.get('alice after upgrade')).toBe('alice')

		// Bob signs in again on the upgraded app.
		await after.disconnect()
		auth.token = 'bob'
		await after.authChanged()
		await cycle(after, 6)

		expect({
			uploadedAs: submittedBy.get('bob offline before upgrade') ?? null,
			held: after.getSyncEngine()?.getStatus().heldOperations ?? 0,
		}).toEqual({ uploadedAs: 'bob', held: 0 })
	}, 60_000)

	test("Alice's pre-upgrade offline writes are not uploaded as Bob", async () => {
		const { auth, submittedBy, mk, cycle } = await setup()
		// Before the upgrade: Alice installs the app and writes offline; it never syncs.
		const before = mk()
		await before.open()
		await before.collection('notes').insert({ body: 'alice offline before upgrade', team: 't1' })
		await before.close()

		// The app is upgraded; Bob is the first to sign in on this laptop.
		auth.token = 'bob'
		const after = mk(() => auth.token)
		await after.open()
		cleanup.push(() => after.close())
		await cycle(after)

		expect(submittedBy.get('alice offline before upgrade') ?? null).not.toBe('bob')
	}, 60_000)
})
