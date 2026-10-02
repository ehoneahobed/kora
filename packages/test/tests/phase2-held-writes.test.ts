/**
 * Phase 2 round-3 fixes, end to end with real stores and the real server:
 * - RT-50: a node whose owner was never recorded is not given to the first user who
 *   signs in. Its owner is learned from the server (an accepted handshake binds it, a
 *   refusal rules that user out), and writes nobody can attribute (a node that never
 *   synced) are held as `unassigned` until the app assigns or discards them.
 * - RT-52: binding the store to a new user does not wait for a session to end; the live
 *   session keeps uploading only the previous user's node.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { KoraEvent } from '@korajs/core'
import { KoraSyncServer, MemoryServerStore, TokenAuthProvider } from '@korajs/server'
import type { ServerTransport } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { TestDevice } from '../src/test-device'
import type { TestServer } from '../src/test-server'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { body: t.string(), team: t.string() } } },
})

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const fn of cleanup.reverse()) await fn()
	cleanup = []
})

async function sharedLaptop() {
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
	const tmp = mkdtempSync(join(tmpdir(), 'held-writes-'))
	cleanup.push(() => rmSync(tmp, { recursive: true, force: true }))
	const auth: { token: string | null } = { token: 'alice' }
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
	const mk = (withPrincipal: boolean) => {
		const device = new TestDevice({
			name: 'laptop',
			schema,
			server: viaToken,
			tmpDir: tmp,
			...(withPrincipal ? { principal: () => auth.token } : {}),
			createTransportPair: () => {
				const pair = createServerTransportPair()
				return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
			},
		})
		return device
	}
	const cycle = async (device: TestDevice, n = 3): Promise<void> => {
		for (let i = 0; i < n; i++) {
			await device.disconnect()
			await device.sync()
		}
	}
	return { auth, submittedBy, mk, cycle, server: store }
}

/** A database that never synced, with a write made before anyone was known to be signed in. */
async function unattributedWrite(ctx: Awaited<ReturnType<typeof sharedLaptop>>): Promise<string> {
	const before = ctx.mk(false)
	await before.open()
	await before.collection('notes').insert({ body: 'nobody knows whose', team: 't1' })
	const nodeId = before.getNodeId()
	await before.close()
	return nodeId
}

describe('RT-50: writes nobody can attribute are held for the app', () => {
	test('they are reported as unassigned, and upload as the user the app assigns them to', async () => {
		const ctx = await sharedLaptop()
		const orphan = await unattributedWrite(ctx)
		ctx.auth.token = 'bob'
		const device = ctx.mk(true)
		await device.open()
		cleanup.push(() => device.close())
		await ctx.cycle(device)
		expect(device.getNodeId()).not.toBe(orphan)
		const engine = device.getSyncEngine()
		if (!engine) throw new Error('no engine')
		expect(ctx.submittedBy.has('nobody knows whose')).toBe(false)
		expect(engine.getStatus()).toMatchObject({
			pendingOperations: 0,
			heldOperations: 1,
			heldNodes: [{ nodeId: orphan, operationCount: 1, reason: 'unassigned', principal: null }],
		})
		expect(await engine.getHeldNodes()).toEqual([
			{ nodeId: orphan, operationCount: 1, reason: 'unassigned', principal: null },
		])

		const events: string[] = []
		device.emitter.on('sync:local-node', (e: KoraEvent) => {
			if (e.type === 'sync:local-node') events.push(e.action)
		})
		await engine.assignHeld(orphan)
		expect(events).toContain('held-assigned')
		await ctx.cycle(device)
		expect(ctx.submittedBy.get('nobody knows whose')).toBe('bob')
		expect(device.getSyncEngine()?.getStatus()).toMatchObject({
			heldOperations: 0,
			heldNodes: [],
		})
		// Bound to Bob by the server's answer: never offered to Alice.
		ctx.auth.token = 'alice'
		await device.authChanged()
		await ctx.cycle(device)
		expect(await device.getSyncEngine()?.getHeldNodes()).toEqual([])
	}, 60_000)

	test('discarded writes are never uploaded and stop counting as held', async () => {
		const ctx = await sharedLaptop()
		const orphan = await unattributedWrite(ctx)
		ctx.auth.token = 'bob'
		const device = ctx.mk(true)
		await device.open()
		cleanup.push(() => device.close())
		await ctx.cycle(device)
		const engine = device.getSyncEngine()
		if (!engine) throw new Error('no engine')
		expect(await engine.discardHeld(orphan)).toBe(1)
		await ctx.cycle(device)
		ctx.auth.token = 'alice'
		await device.authChanged()
		await ctx.cycle(device)
		expect(ctx.submittedBy.has('nobody knows whose')).toBe(false)
		expect(device.getSyncEngine()?.getStatus()).toMatchObject({
			heldOperations: 0,
			pendingOperations: 0,
		})
		// Still in the local database: discarding is not a rollback.
		expect((await device.getState('notes')).map((r) => r.body)).toContain('nobody knows whose')
		await expect(device.getSyncEngine()?.discardHeld(orphan)).rejects.toMatchObject({
			context: { code: 'HELD_NODE_NOT_DISCARDABLE' },
		})
	}, 60_000)

	test("another user's held writes can be neither assigned nor discarded", async () => {
		const ctx = await sharedLaptop()
		const device = ctx.mk(true)
		await device.open()
		cleanup.push(() => device.close())
		await device.sync()
		await device.disconnect()
		const aliceNode = device.getNodeId()
		await device.collection('notes').insert({ body: 'alice offline', team: 't1' })
		ctx.auth.token = 'bob'
		await device.authChanged()
		await ctx.cycle(device)
		const engine = device.getSyncEngine()
		if (!engine) throw new Error('no engine')
		expect(await engine.getHeldNodes()).toEqual([
			{ nodeId: aliceNode, operationCount: 1, reason: 'other-user', principal: 'alice' },
		])
		await expect(engine.assignHeld(aliceNode)).rejects.toMatchObject({
			context: { code: 'HELD_NODE_NOT_ASSIGNABLE' },
		})
		await expect(engine.discardHeld(aliceNode)).rejects.toMatchObject({
			context: { code: 'HELD_NODE_NOT_DISCARDABLE' },
		})
		ctx.auth.token = null
		await expect(engine.assignHeld(aliceNode)).rejects.toMatchObject({
			context: { code: 'HELD_ASSIGN_NO_USER' },
		})
	}, 60_000)

	test('a node accepted before is tried once per user: refused for one, bound to its owner', async () => {
		const ctx = await sharedLaptop()
		// Before the upgrade: Bob synced on this laptop, then wrote offline.
		ctx.auth.token = 'bob'
		const before = ctx.mk(false)
		await before.open()
		await before.sync()
		await before.disconnect()
		const bobNode = before.getNodeId()
		await before.collection('notes').insert({ body: 'bob offline', team: 't1' })
		await before.close()

		ctx.auth.token = 'alice'
		const device = ctx.mk(true)
		await device.open()
		cleanup.push(() => device.close())
		const refused: string[] = []
		device.emitter.on('sync:local-node', (e: KoraEvent) => {
			if (e.type === 'sync:local-node' && e.action === 'adoption-refused') refused.push(e.nodeId)
		})
		await ctx.cycle(device, 4)
		// Tried once for Alice, refused, then held for its owner.
		expect(refused).toEqual([bobNode])
		expect(await device.getSyncEngine()?.getHeldNodes()).toEqual([
			{ nodeId: bobNode, operationCount: 1, reason: 'other-user', principal: null },
		])
		expect(ctx.submittedBy.has('bob offline')).toBe(false)

		ctx.auth.token = 'bob'
		await device.authChanged()
		await ctx.cycle(device)
		expect(ctx.submittedBy.get('bob offline')).toBe('bob')
		expect(await device.getSyncEngine()?.getHeldNodes()).toEqual([])
		// Drained, so forgotten: or else bound to Bob from the server's answer.
		const node = (await device.store.listLocalNodes()).find((entry) => entry.nodeId === bobNode)
		if (node) expect(node).toMatchObject({ principal: 'bob', binding: 'server' })
	}, 60_000)
})

describe('RT-52: the store binds to a new user without waiting for the session', () => {
	test("a live session keeps uploading only the previous user's node", async () => {
		const ctx = await sharedLaptop()
		const device = ctx.mk(true)
		await device.open()
		cleanup.push(() => device.close())
		await device.sync()
		const aliceNode = device.getNodeId()
		const engine = device.getSyncEngine()
		if (!engine) throw new Error('no engine')

		ctx.auth.token = 'bob'
		await engine.bindSignedInUser()
		expect(device.getNodeId()).not.toBe(aliceNode)
		// Made while Alice's session is still live: Bob's node, never uploaded on it.
		// (TestDevice pushes it to the live engine, as createApp does.)
		await device.collection('notes').insert({ body: 'bob live', team: 't1' })
		await new Promise((resolve) => setTimeout(resolve, 100))
		expect(ctx.submittedBy.has('bob live')).toBe(false)

		await ctx.cycle(device)
		expect(ctx.submittedBy.get('bob live')).toBe('bob')
	}, 60_000)
})
