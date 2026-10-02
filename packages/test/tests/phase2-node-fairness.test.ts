/**
 * Phase 2 round-2 fixes, end to end with real stores and the real server:
 * - RT-46: per-tab adoption takes turns; a node the server keeps deferring is parked and
 *   never blocks the other closed tabs or the open tab's own writes.
 * - RT-42: an auth-aware device binds writes to the signed-in user; another user's
 *   unsynced writes are held (reported) and upload only on their owner's session.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { KoraEvent } from '@korajs/core'
import { KoraSyncServer, MemoryServerStore, TokenAuthProvider } from '@korajs/server'
import type { ServerTransport } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import { Store } from '@korajs/store'
import type { StorageAdapter } from '@korajs/store'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { TestDevice } from '../src/test-device'
import { TestServer } from '../src/test-server'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { body: t.string(), team: t.string().optional() } } },
})

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const fn of cleanup.reverse()) await fn()
	cleanup = []
})

function pair(): { client: SyncTransport; serverTransport: ServerTransport } {
	const p = createServerTransportPair()
	return { client: p.client as unknown as SyncTransport, serverTransport: p.server }
}

function perTabDevice(server: TestServer, dir: string): TestDevice {
	const device = new TestDevice({
		name: 'browser',
		schema,
		server,
		tmpDir: dir,
		createTransportPair: pair,
	})
	const internals = device as unknown as { store: Store; adapter: StorageAdapter }
	internals.store = new Store({
		schema,
		adapter: internals.adapter,
		emitter: device.emitter,
		isolation: 'per-tab',
	})
	return device
}

describe('RT-46: three closed tabs and an open one', () => {
	test('a write the server defers forever never blocks the other tabs or the open tab', async () => {
		let deferredAttempts = 0
		const server = new TestServer(schema, {
			validateOperation: async (op) => {
				if (op.data?.body !== 'deferred forever') return { action: 'accept' }
				deferredAttempts++
				return { action: 'reject', code: 'NOT_YET', message: 'try again later', retriable: true }
			},
		})
		cleanup.push(() => server.close())
		const dir = mkdtempSync(join(tmpdir(), 'rt46-3tabs-'))
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }))

		// Three tabs write offline and close; the stuck one is the oldest (first in turn).
		const bodies = ['deferred forever', 'second tab', 'third tab']
		for (const body of bodies) {
			const tab = perTabDevice(server, dir)
			await tab.open()
			await tab.collection('notes').insert({ body })
			await tab.close()
		}

		const open = perTabDevice(server, dir)
		await open.open()
		cleanup.push(() => open.close())
		const parked: KoraEvent[] = []
		open.emitter.on('sync:local-node', (e) => {
			if (e.type === 'sync:local-node' && e.action === 'adoption-parked') parked.push(e)
		})
		await open.collection('notes').insert({ body: 'open tab' })
		for (let i = 0; i < 6; i++) {
			await open.disconnect()
			await open.sync()
		}

		const onServer = server
			.getAllOperations()
			.map((op) => String(op.data?.body))
			.sort()
		expect(onServer).toEqual(['open tab', 'second tab', 'third tab'])
		// The deferred write is parked, kept and reported, never dropped.
		expect(parked.length).toBeGreaterThan(0)
		expect(open.getSyncEngine()?.getStatus().pendingOperations).toBe(1)
		// Bounded: the stuck node is retried only after other progress or its backoff,
		// not on every session (one attempt per other node that made progress).
		expect(deferredAttempts).toBeLessThanOrEqual(3)
	}, 60_000)
})

describe('RT-42: an auth-aware device on a shared database', () => {
	test("Alice's offline writes are held while Bob is signed in and upload as Alice later", async () => {
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
				submittedBy.set(String(op.data?.body), String(ctx.auth?.userId))
				return { action: 'accept' }
			},
		})
		cleanup.push(() => server.stop())
		const dir = mkdtempSync(join(tmpdir(), 'rt42-held-'))
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
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
		const device = new TestDevice({
			name: 'shared',
			schema,
			server: viaToken,
			tmpDir: dir,
			principal: () => auth.user,
			createTransportPair: pair,
		})
		await device.open()
		cleanup.push(() => device.close())

		await device.collection('notes').insert({ body: 'alice offline', team: 't1' })
		auth.user = 'bob'
		await device.authChanged()
		await device.collection('notes').insert({ body: 'bob note', team: 't1' })
		await device.sync()
		expect(device.getSyncEngine()?.getStatus()).toMatchObject({
			pendingOperations: 0,
			heldOperations: 1,
		})
		expect(submittedBy.get('bob note')).toBe('bob')
		expect(submittedBy.has('alice offline')).toBe(false)

		auth.user = 'alice'
		await device.authChanged()
		await device.disconnect()
		await device.sync()
		expect(submittedBy.get('alice offline')).toBe('alice')
		expect(device.getSyncEngine()?.getStatus()).toMatchObject({ heldOperations: 0 })
	}, 60_000)
})
