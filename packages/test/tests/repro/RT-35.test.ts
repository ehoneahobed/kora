/**
 * RT-35 repro (Phase 2 red team, 2026-10-02): an operation can be uploaded and
 * acknowledged before it is durable on the device. If the device then loses that
 * tail (the IndexedDB fallback persists a whole-database snapshot on a 500 ms
 * debounce, `IndexedDbAdapter` + `IndexedDbPersistenceScheduler`; nothing in sync
 * calls `flushPersistence()` before sending), the device restarts with its sequence
 * counter behind the server:
 *
 * 1. its next write reuses the lost op's sequence number with different content and
 *    the server refuses it with the NON-retriable SEQUENCE_CONFLICT: a write made
 *    after the restart never syncs (recorded as rejected);
 * 2. the lost op itself is never delivered back to its author (a resumed delivery
 *    stream excludes the client's own node), so device and server diverge for good.
 *
 * The test simulates the lost tail by restoring the database file to the snapshot
 * taken before the last write (what IndexedDB holds when the tab dies inside the
 * debounce window). Asserts the CORRECT behaviour (fails today).
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncTransport } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { TestDevice } from '../../src/test-device'
import { TestServer } from '../../src/test-server'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const fn of cleanup.reverse()) await fn()
	cleanup = []
})

function makeDevice(server: TestServer, tmp: string): TestDevice {
	return new TestDevice({
		name: 'laptop',
		schema,
		server,
		tmpDir: tmp,
		createTransportPair: () => {
			const pair = createServerTransportPair()
			return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
		},
	})
}

describe('RT-35: uploaded-before-durable tail loss', () => {
	test('a write after losing an acknowledged tail still syncs, and the lost op comes back', async () => {
		const server = new TestServer(schema)
		cleanup.push(() => server.close())
		const tmp = mkdtempSync(join(tmpdir(), 'rt35-'))
		cleanup.push(() => rmSync(tmp, { recursive: true, force: true }))
		const dbPath = join(tmp, 'test-device-laptop.db')

		const d1 = makeDevice(server, tmp)
		await d1.open()
		await d1.sync()
		await d1.collection('todos').insert({ title: 'first' })
		await d1.sync()
		// Another device writes, so this device's delivery watermark is past 0.
		const peer = new TestDevice({
			name: 'phone',
			schema,
			server,
			tmpDir: tmp,
			createTransportPair: () => {
				const pair = createServerTransportPair()
				return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
			},
		})
		await peer.open()
		cleanup.push(() => peer.close())
		await peer.sync()
		await peer.collection('todos').insert({ title: 'from the phone' })
		await peer.sync()
		await d1.sync()
		await d1.sync()

		// The last durable snapshot (IndexedDB) is taken here...
		const adapter = (d1 as unknown as { adapter: { execute(sql: string): Promise<void> } }).adapter
		await adapter.execute(`VACUUM INTO '${join(tmp, 'snapshot.db')}'`)

		// ...then a write is uploaded and acknowledged inside the debounce window.
		const lost = await d1.collection('todos').insert({ title: 'uploaded, then lost locally' })
		await d1.sync()
		expect(server.getAllOperations().some((op) => op.recordId === lost.id)).toBe(true)
		expect(d1.getSyncEngine()?.getStatus().pendingOperations).toBe(0)

		// The tab dies before the snapshot is written; on reload the database is the snapshot.
		await d1.close()
		rmSync(`${dbPath}-wal`, { force: true })
		rmSync(`${dbPath}-shm`, { force: true })
		copyFileSync(join(tmp, 'snapshot.db'), dbPath)

		const d2 = makeDevice(server, tmp)
		await d2.open()
		cleanup.push(() => d2.close())
		await d2.sync()
		const after = await d2.collection('todos').insert({ title: 'written after reload' })
		for (let i = 0; i < 3; i++) await d2.sync()

		const rejected = (await d2.getRejectedOperations()).map((r) => r.code)
		const serverHasNew = server.getAllOperations().some((op) => op.recordId === after.id)
		const deviceHasLost = (await d2.collection('todos').findById(lost.id)) !== null
		expect({ rejected, serverHasNew, deviceHasLost }).toEqual({
			rejected: [],
			serverHasNew: true,
			deviceHasLost: true,
		})
	})
})
