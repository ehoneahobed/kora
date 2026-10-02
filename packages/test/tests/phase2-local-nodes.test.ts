/**
 * Phase 2 (RT-35, RT-38, RT-40): end-to-end behaviour of the client's local-node
 * bookkeeping beyond the red-team repros, against the real server and SQLite stores.
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
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

function tmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
	return dir
}

function events(device: TestDevice, type: KoraEvent['type']): KoraEvent[] {
	const seen: KoraEvent[] = []
	device.emitter.on(type, (event) => seen.push(event))
	return seen
}

describe('RT-35: a write made offline after losing the log tail', () => {
	test('reuses a lost sequence number, is renumbered on SEQUENCE_CONFLICT, and the lost op comes back', async () => {
		const server = new TestServer(schema)
		cleanup.push(() => server.close())
		const dir = tmp('p2-rt35-')
		const dbPath = join(dir, 'test-device-laptop.db')
		const d1 = new TestDevice({
			name: 'laptop',
			schema,
			server,
			tmpDir: dir,
			createTransportPair: pair,
		})
		await d1.open()
		await d1.sync()
		await d1.collection('notes').insert({ body: 'first' })
		await d1.sync()
		const adapter = (d1 as unknown as { adapter: { execute(sql: string): Promise<void> } }).adapter
		await adapter.execute(`VACUUM INTO '${join(dir, 'snapshot.db')}'`)
		const lost = await d1.collection('notes').insert({ body: 'uploaded, then lost' })
		await d1.sync()
		await d1.close()
		rmSync(`${dbPath}-wal`, { force: true })
		rmSync(`${dbPath}-shm`, { force: true })
		copyFileSync(join(dir, 'snapshot.db'), dbPath)

		const d2 = new TestDevice({
			name: 'laptop',
			schema,
			server,
			tmpDir: dir,
			createTransportPair: pair,
		})
		await d2.open()
		cleanup.push(() => d2.close())
		const recovery = events(d2, 'sync:local-node')
		// Offline first: this write takes the lost operation's sequence number.
		const offline = await d2.collection('notes').insert({ body: 'written offline after reload' })
		const offlineOp = (await d2.store.getOperationRange(d2.getNodeId(), 1, 10)).find(
			(op) => op.recordId === offline.id,
		)
		expect(offlineOp?.sequenceNumber).toBe(2)
		for (let i = 0; i < 4; i++) await d2.sync()

		const serverOps = server.getAllOperations()
		const stored = serverOps.filter((op) => op.recordId === offline.id)
		expect(stored).toHaveLength(1)
		expect(stored[0]?.sequenceNumber).toBeGreaterThan(2)
		expect(stored[0]?.id).toBe(offlineOp?.id)
		expect(await d2.collection('notes').findById(lost.id)).not.toBeNull()
		expect(await d2.getRejectedOperations()).toEqual([])
		expect(
			recovery.some((e) => e.type === 'sync:local-node' && e.action === 'history-behind'),
		).toBe(true)
		expect(d2.getSyncEngine()?.getStatus().pendingOperations).toBe(0)
	})
})

describe('RT-38: users sharing one local database', () => {
	async function sharedLaptop(): Promise<{
		device: TestDevice
		submittedBy: Map<string, string[]>
		store: MemoryServerStore
		setToken(token: string): void
		dropAcks(drop: boolean): void
	}> {
		const store = new MemoryServerStore()
		await store.setSchema(schema)
		const submittedBy = new Map<string, string[]>()
		const server = new KoraSyncServer({
			store,
			relayRetransmitIntervalMs: 0,
			deliveryPollIntervalMs: 0,
			auth: new TokenAuthProvider({
				validate: async (token) => ({ userId: token, scopes: { notes: { team: 't1' } } }),
			}),
			validateOperation: async (op, ctx) => {
				const key = String(op.data?.body ?? op.id)
				submittedBy.set(key, [...(submittedBy.get(key) ?? []), String(ctx.auth?.userId)])
				return { action: 'accept' }
			},
		})
		cleanup.push(() => server.stop())
		let token = 'alice'
		let dropping = false
		const viaToken = {
			handleConnection(transport: ServerTransport): string {
				return server.handleConnection({
					send: (m: SyncMessage) => {
						if (dropping && m.type === 'acknowledgment') return
						transport.send(m)
					},
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
			tmpDir: tmp('p2-rt38-'),
			createTransportPair: pair,
		})
		await device.open()
		cleanup.push(() => device.close())
		return {
			device,
			submittedBy,
			store,
			setToken: (next) => {
				token = next
			},
			dropAcks: (drop) => {
				dropping = drop
			},
		}
	}

	async function switchUser(device: TestDevice, rounds = 3): Promise<void> {
		for (let i = 0; i < rounds; i++) {
			await device.disconnect()
			await device.sync()
		}
	}

	test("Alice's held draft is uploaded as Alice when she signs in again, and Bob's write as Bob", async () => {
		const { device, submittedBy, setToken } = await sharedLaptop()
		await device.sync()
		await device.collection('notes').insert({ body: 'alice synced', team: 't1' })
		await device.sync()
		const aliceNode = device.getNodeId()

		await device.disconnect()
		await device.collection('notes').insert({ body: 'alice offline draft', team: 't1' })
		setToken('bob')
		await switchUser(device)
		const bobNode = device.getNodeId()
		expect(bobNode).not.toBe(aliceNode)
		expect(device.getSyncEngine()?.getStatus().heldOperations).toBe(1)
		expect(device.getSyncEngine()?.getStatus().pendingOperations).toBe(0)
		await device.collection('notes').insert({ body: 'bob note', team: 't1' })
		await device.sync()
		expect(submittedBy.get('bob note')).toEqual(['bob'])
		expect(submittedBy.get('alice offline draft')).toBeUndefined()

		setToken('alice')
		await switchUser(device)
		expect(device.getNodeId()).toBe(aliceNode)
		expect(submittedBy.get('alice offline draft')).toEqual(['alice'])
		expect(device.getSyncEngine()?.getStatus().heldOperations).toBe(0)

		// A third user gets a fresh node; nobody's writes are attributed to them.
		setToken('carol')
		await switchUser(device, 4)
		expect([aliceNode, bobNode]).not.toContain(device.getNodeId())
		for (const [body, users] of submittedBy) {
			if (body !== 'alice synced' && body !== 'alice offline draft' && body !== 'bob note') continue
			expect(users).not.toContain('carol')
		}
	})

	test('an op sent but not acknowledged before the switch is stored once', async () => {
		const { device, store, setToken, dropAcks } = await sharedLaptop()
		await device.sync()
		dropAcks(true)
		const note = await device.collection('notes').insert({ body: 'counter', team: 't1' })
		await device.sync()
		dropAcks(false)
		await device.disconnect()

		setToken('bob')
		await switchUser(device)
		setToken('alice')
		await switchUser(device)

		const copies = store.getAllOperations().filter((op) => op.recordId === note.id)
		expect(copies).toHaveLength(1)
		expect(device.getSyncEngine()?.getStatus().pendingOperations).toBe(0)
	})
})

describe('RT-40: per-tab isolation', () => {
	function perTab(server: TestServer, dir: string): TestDevice {
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

	test("a closed tab's writes are adopted with their identity; the adopting tab's own writes follow", async () => {
		const server = new TestServer(schema)
		cleanup.push(() => server.close())
		const dir = tmp('p2-rt40-')
		const tab1 = perTab(server, dir)
		await tab1.open()
		await tab1.sync()
		await tab1.disconnect()
		const a = await tab1.collection('notes').insert({ body: 'tab 1, offline' })
		const b = await tab1.collection('notes').insert({ body: 'tab 1, offline, again' })
		const tab1Node = tab1.getNodeId()
		await tab1.close()

		const tab2 = perTab(server, dir)
		await tab2.open()
		cleanup.push(() => tab2.close())
		const adoption = events(tab2, 'sync:local-node')
		const own = await tab2.collection('notes').insert({ body: 'tab 2, before connecting' })
		for (let i = 0; i < 3; i++) {
			await tab2.disconnect()
			await tab2.sync()
		}
		const serverOps = server.getAllOperations()
		const adopted = serverOps.filter((op) => op.recordId === a.id || op.recordId === b.id)
		expect(adopted.map((op) => op.nodeId)).toEqual([tab1Node, tab1Node])
		expect(serverOps.some((op) => op.recordId === own.id && op.nodeId === tab2.getNodeId())).toBe(
			true,
		)
		expect(adoption).toContainEqual(
			expect.objectContaining({ action: 'adoption-started', nodeId: tab1Node, operationCount: 2 }),
		)
		expect(adoption).toContainEqual(
			expect.objectContaining({ action: 'adoption-completed', nodeId: tab1Node }),
		)
		expect(tab2.getSyncEngine()?.getStatus().pendingOperations).toBe(0)
	})
})
