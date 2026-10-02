/**
 * RT-45 repro (Phase 2 red team round 2, 2026-10-02): the server is restored from an
 * older backup (it is BEHIND the devices). A device whose node has NO operation in the
 * backup never re-uploads what the server lost: the restored server's handshake vector
 * has no entry for that node, and the engine lowers its acknowledged prefix only when
 * the advertised own entry is present and lower (`advertisedOwn !== undefined &&
 * advertisedOwn < this.ownAckedThrough`, sync-engine.ts). An absent entry is the
 * strongest form of "the server holds fewer of my operations" (zero), but it is read
 * as "no information". Device b's three increments exist only on devices; the server,
 * and every device that joins later, never get them (silent loss on the server).
 *
 * Device a (whose node does have an op in the backup) re-uploads correctly, once.
 *
 * Asserts the CORRECT behaviour (fails today): after the restore, the server ends with
 * every operation, each submitted once.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, op, t } from '@korajs/core'
import { KoraSyncServer, MemoryServerStore } from '@korajs/server'
import type { ServerTransport } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncTransport } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { TestDevice } from '../../src/test-device'
import type { TestServer } from '../../src/test-server'

const schema = defineSchema({
	version: 1,
	collections: {
		counters: { fields: { name: t.string(), count: t.number().default(0) } },
	},
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

describe('RT-45: server restored from an older backup', () => {
	test('devices re-upload the lost tail once and converge', async () => {
		let store = new MemoryServerStore()
		await store.setSchema(schema)
		const received = new Map<string, number>()
		const mkServer = (s: MemoryServerStore) =>
			new KoraSyncServer({
				store: s,
				relayRetransmitIntervalMs: 0,
				deliveryPollIntervalMs: 0,
				validateOperation: async (o) => {
					received.set(o.id, (received.get(o.id) ?? 0) + 1)
					return { action: 'accept' }
				},
			})
		let server = mkServer(store)
		cleanup.push(() => server.stop())
		const proxy = {
			handleConnection: (t: ServerTransport) => server.handleConnection(t),
		} as unknown as TestServer
		const dir = mkdtempSync(join(tmpdir(), 'r2-behind-'))
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
		const mk = (name: string) =>
			new TestDevice({ name, schema, server: proxy, tmpDir: dir, createTransportPair: pair })
		const a = mk('a')
		const b = mk('b')
		await a.open()
		await b.open()
		cleanup.push(() => a.close())
		cleanup.push(() => b.close())
		await a.sync()
		await b.sync()
		const c = await a.collection('counters').insert({ name: 'c', count: 0 })
		await a.sync()
		await b.sync()
		// The backup is taken here.
		const backup = store.getAllOperations()
		for (let i = 1; i <= 3; i++) {
			await a.collection('counters').update(c.id, { count: op.increment(i) })
			await b.collection('counters').update(c.id, { count: op.increment(10 * i) })
			await a.sync()
			await b.sync()
		}
		await a.sync()
		await b.sync()
		await a.disconnect()
		await b.disconnect()

		// Restore the server from the backup.
		await server.stop()
		store = new MemoryServerStore()
		await store.setSchema(schema)
		for (const o of backup) await store.applyRemoteOperation(o)
		server = mkServer(store)
		received.clear()

		for (let i = 0; i < 5; i++) {
			await a.sync()
			await b.sync()
			await a.disconnect()
			await b.disconnect()
		}
		await a.sync()
		await b.sync()
		const countOn = async (d: TestDevice) =>
			(await d.collection('counters').findById(c.id))?.count ?? null
		const serverRow = (await store.queryCollection('counters', { where: { id: c.id } }))[0]
		expect({
			a: await countOn(a),
			b: await countOn(b),
			server: serverRow?.count,
			serverOps: store.getAllOperations().length,
			maxSubmissions: Math.max(0, ...received.values()),
		}).toEqual({ a: 66, b: 66, server: 66, serverOps: 7, maxSubmissions: 1 })
	}, 60_000)
})
