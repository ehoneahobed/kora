/**
 * Phase 2 red team round 2 (2026-10-02): lost-tail recovery (RT-35 fix) with atomic
 * increments, deletes and more new offline writes than lost operations. The device
 * loses the last three uploaded operations (restored snapshot), then writes four new
 * ones offline (two reuse lost numbers). After sync, every replica must hold the lost
 * operations exactly once and the new ones exactly once.
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, op, t } from '@korajs/core'
import type { ServerTransport } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncTransport } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { TestDevice } from '../src/test-device'
import { TestServer } from '../src/test-server'

const schema = defineSchema({
	version: 1,
	collections: {
		counters: { fields: { name: t.string(), count: t.number().default(0) } },
		notes: { fields: { body: t.string() } },
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

describe('round 2: lost-tail recovery is exactly-once', () => {
	test('lost increments and delete come back once; new offline writes sync once', async () => {
		const server = new TestServer(schema)
		cleanup.push(() => server.close())
		const dir = mkdtempSync(join(tmpdir(), 'r2-lost-tail-'))
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
		const dbPath = join(dir, 'test-device-laptop.db')
		const mk = (name: string) =>
			new TestDevice({ name, schema, server, tmpDir: dir, createTransportPair: pair })

		const peer = mk('peer')
		await peer.open()
		cleanup.push(() => peer.close())
		const d1 = mk('laptop')
		await d1.open()
		await d1.sync()
		const counter = await d1.collection('counters').insert({ name: 'c', count: 0 })
		const doomed = await d1.collection('notes').insert({ body: 'to be deleted' })
		const kept = await d1.collection('notes').insert({ body: 'v1' })
		await d1.sync()
		const adapter = (d1 as unknown as { adapter: { execute(sql: string): Promise<void> } }).adapter
		await adapter.execute(`VACUUM INTO '${join(dir, 'snapshot.db')}'`)
		// Uploaded and acknowledged, then lost.
		await d1.collection('counters').update(counter.id, { count: op.increment(5) })
		await d1.collection('notes').delete(doomed.id)
		await d1.collection('notes').update(kept.id, { body: 'v2 (lost)' })
		await d1.sync()
		await d1.close()
		rmSync(`${dbPath}-wal`, { force: true })
		rmSync(`${dbPath}-shm`, { force: true })
		copyFileSync(join(dir, 'snapshot.db'), dbPath)

		const d2 = mk('laptop')
		await d2.open()
		cleanup.push(() => d2.close())
		// Offline after the reload: four writes, three of them reuse lost numbers.
		await d2.collection('counters').update(counter.id, { count: op.increment(3) })
		await d2.collection('counters').update(counter.id, { count: op.increment(7) })
		await d2.collection('notes').insert({ body: 'new after reload' })
		await d2.collection('counters').update(counter.id, { count: op.increment(11) })
		for (let i = 0; i < 6; i++) {
			await d2.sync()
			await peer.sync()
			await d2.disconnect()
			await peer.disconnect()
		}
		await d2.sync()
		await peer.sync()

		const serverCounter = server
			.getAllOperations()
			.filter((o) => o.collection === 'counters' && o.recordId === counter.id)
		const countOn = async (d: TestDevice) =>
			(await d.collection('counters').findById(counter.id))?.count ?? null
		const notesOn = async (d: TestDevice) =>
			(await d.getState('notes')).map((n) => String(n.body)).sort()

		expect({
			serverCounterOps: serverCounter.length,
			d2: await countOn(d2),
			peer: await countOn(peer),
			d2Notes: await notesOn(d2),
			peerNotes: await notesOn(peer),
			pending: d2.getSyncEngine()?.getStatus().pendingOperations,
			rejected: (await d2.getRejectedOperations()).length,
		}).toEqual({
			serverCounterOps: 5, // insert + 4 increments
			d2: 26,
			peer: 26,
			d2Notes: ['new after reload', 'v2 (lost)'],
			peerNotes: ['new after reload', 'v2 (lost)'],
			pending: 0,
			rejected: 0,
		})
	}, 60_000)
})
