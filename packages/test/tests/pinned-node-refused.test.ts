/**
 * F9 follow-up: a pinned store node id (`StoreConfig.nodeId`) that the sync server says
 * another user owns. The device cannot move to a fresh node (the id is pinned), so writes
 * made under it could only ever upload as that owner. Once the server says so, local
 * writes are refused (`NODE_OWNED_BY_ANOTHER_USER`) instead of piling up under the
 * other user's node. A refusal that only means "history with no recorded owner" (a
 * beta.12 node the server may still hand over or an operator may bind) keeps writes on.
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
import { TestDevice } from '../src/test-device'
import type { TestServer } from '../src/test-server'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { body: t.string() } } },
})

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const fn of cleanup.reverse()) await fn()
	cleanup = []
})

async function setup() {
	const store = new MemoryServerStore()
	await store.setSchema(schema)
	const server = new KoraSyncServer({
		store,
		relayRetransmitIntervalMs: 0,
		deliveryPollIntervalMs: 0,
		unscopedSharing: 'allow',
		auth: new TokenAuthProvider({ validate: async (token) => ({ userId: token }) }),
	})
	cleanup.push(() => server.stop())
	const tmp = mkdtempSync(join(tmpdir(), 'pinned-refused-'))
	cleanup.push(() => rmSync(tmp, { recursive: true, force: true }))
	const device = (name: string, token: string, nodeId: string): TestDevice => {
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
		const d = new TestDevice({
			name,
			schema,
			server: viaToken,
			tmpDir: tmp,
			nodeId,
			principal: () => token,
			createTransportPair: () => {
				const pair = createServerTransportPair()
				return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
			},
		})
		cleanup.push(() => d.close())
		return d
	}
	return { store, server, device }
}

describe('a pinned node another user owns (F9)', () => {
	test('local writes are refused once the server says the node is another user’s', async () => {
		const ctx = await setup()
		const alice = ctx.device('alice-laptop', 'alice', 'shared-node')
		await alice.open()
		await alice.collection('notes').insert({ body: 'alice' })
		await alice.sync()

		const bob = ctx.device('bob-laptop', 'bob', 'shared-node')
		await bob.open()
		await bob.collection('notes').insert({ body: 'bob before the refusal' })
		await bob.sync().catch(() => undefined)
		await bob.disconnect()
		await expect(bob.collection('notes').insert({ body: 'bob after' })).rejects.toMatchObject({
			code: 'NODE_OWNED_BY_ANOTHER_USER',
		})
	}, 60_000)

	test('a refusal for history with no recorded owner keeps local writes on', async () => {
		const ctx = await setup()
		// beta.12 history under the node, with no owner recorded.
		const legacy = ctx.device('legacy', 'nobody', 'legacy-node')
		await legacy.open()
		await legacy.collection('notes').insert({ body: 'beta.12' })
		const [op] = await legacy.store.getOperationRange(legacy.getNodeId(), 1, 1)
		if (!op) throw new Error('no operation')
		await ctx.store.applyRemoteOperation(op)
		await legacy.close()

		const carol = ctx.device('carol-laptop', 'carol', 'legacy-node')
		await carol.open()
		await carol.sync().catch(() => undefined)
		await carol.disconnect()
		await expect(carol.collection('notes').insert({ body: 'carol offline' })).resolves.toBeTruthy()
	}, 60_000)
})
