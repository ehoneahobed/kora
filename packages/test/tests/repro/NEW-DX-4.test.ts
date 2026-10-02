/**
 * NEW-DX-4 (acceptance).
 * `sync.unassignedWrites` (RT-50 opt-out), end to end with a real store and the real
 * server. Writes made on a database that never synced, before the app knew who was
 * signed in, are held as `unassigned` by default. With 'assign-to-first-user' they go
 * to the first user the server accepts a session for, and upload as that user.
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
import { wireUnassignedWritesPolicy } from '../../../../kora/src/unassigned-writes'
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

async function laptop(policy: 'hold' | 'assign-to-first-user') {
	const store = new MemoryServerStore()
	await store.setSchema(schema)
	const submittedBy = new Map<string, string>()
	const server = new KoraSyncServer({
		store,
		relayRetransmitIntervalMs: 0,
		deliveryPollIntervalMs: 0,
		auth: new TokenAuthProvider({
			validate: async (token) =>
				token === 'mallory' ? null : { userId: token, scopes: { notes: { team: 't1' } } },
		}),
		validateOperation: async (op, ctx) => {
			submittedBy.set(String(op.data?.body ?? op.id), String(ctx.auth?.userId))
			return { action: 'accept' }
		},
	})
	cleanup.push(() => server.stop())
	const tmp = mkdtempSync(join(tmpdir(), 'unassigned-policy-'))
	cleanup.push(() => rmSync(tmp, { recursive: true, force: true }))
	const auth: { token: string | null } = { token: null }
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
			reconnectable: true,
			...(withPrincipal ? { principal: () => auth.token } : {}),
			createTransportPair: () => {
				const pair = createServerTransportPair()
				return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
			},
		})
		if (withPrincipal) {
			const unsubscribe = wireUnassignedWritesPolicy(
				{ schema, sync: { url: 'ws://test', unassignedWrites: policy } },
				device.emitter,
				() => device.getSyncEngine(),
				() => false,
			)
			cleanup.push(unsubscribe)
		}
		return device
	}
	const cycle = async (device: TestDevice, n = 3): Promise<void> => {
		for (let i = 0; i < n; i++) {
			await device.disconnect()
			await device.sync()
		}
	}
	// Offline, before anyone signed in: a write nobody can attribute.
	const before = mk(false)
	await before.open()
	await before.collection('notes').insert({ body: 'written before sign-in', team: 't1' })
	const orphan = before.getNodeId()
	await before.close()
	return { auth, submittedBy, mk, cycle, orphan }
}

describe('sync.unassignedWrites', () => {
	test("'hold' (default) keeps them held for the app to decide", async () => {
		const ctx = await laptop('hold')
		ctx.auth.token = 'bob'
		const device = ctx.mk(true)
		await device.open()
		cleanup.push(() => device.close())
		await ctx.cycle(device)
		expect(ctx.submittedBy.has('written before sign-in')).toBe(false)
		expect(await device.getSyncEngine()?.getHeldNodes()).toEqual([
			{ nodeId: ctx.orphan, operationCount: 1, reason: 'unassigned', principal: null },
		])
	}, 60_000)

	test("'assign-to-first-user' gives them to the first user the server accepts", async () => {
		const ctx = await laptop('assign-to-first-user')
		// A user the server refuses never gets a session, so never gets them.
		ctx.auth.token = 'mallory'
		const device = ctx.mk(true)
		await device.open()
		cleanup.push(() => device.close())
		await device.sync().catch(() => undefined)
		expect(ctx.submittedBy.has('written before sign-in')).toBe(false)

		ctx.auth.token = 'bob'
		await device.authChanged()
		await ctx.cycle(device)
		expect(ctx.submittedBy.get('written before sign-in')).toBe('bob')
		expect(device.getSyncEngine()?.getStatus()).toMatchObject({ heldOperations: 0, heldNodes: [] })

		// Bob owns them now: Alice signing in later is never offered them.
		ctx.auth.token = 'alice'
		await device.authChanged()
		await ctx.cycle(device)
		expect(await device.getSyncEngine()?.getHeldNodes()).toEqual([])
		expect(ctx.submittedBy.get('written before sign-in')).toBe('bob')
	}, 60_000)
})
