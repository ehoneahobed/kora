/**
 * RT-40 repro (Phase 2 red team, 2026-10-02): with `store.isolation: 'per-tab'` every
 * tab writes under its own node id (sessionStorage) into ONE shared database. Upload
 * tracking (W3) covers only the CURRENT node id's contiguous prefix, so the unsynced
 * operations of a tab that closed (offline, or before its batch was acknowledged) stay
 * in the shared log forever: no later tab uploads them, nothing reports them as
 * pending, and the data exists only on this device.
 *
 * Asserts the CORRECT behaviour (fails today): a later tab uploads them.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { createServerTransportPair } from '@korajs/server/internal'
import { Store } from '@korajs/store'
import type { StorageAdapter } from '@korajs/store'
import type { SyncTransport } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { TestDevice } from '../../src/test-device'
import { TestServer } from '../../src/test-server'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { body: t.string() } } },
})

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const fn of cleanup.reverse()) await fn()
	cleanup = []
})

/** A TestDevice whose store uses per-tab isolation (a fresh node id per instance). */
function perTabDevice(server: TestServer, tmp: string): TestDevice {
	const device = new TestDevice({
		name: 'browser',
		schema,
		server,
		tmpDir: tmp,
		createTransportPair: () => {
			const pair = createServerTransportPair()
			return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
		},
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

describe('RT-40: per-tab isolation strands a closed tab unsynced writes', () => {
	test('a write from a tab that closed offline reaches the server through a later tab', async () => {
		const server = new TestServer(schema)
		cleanup.push(() => server.close())
		const tmp = mkdtempSync(join(tmpdir(), 'rt40-'))
		cleanup.push(() => rmSync(tmp, { recursive: true, force: true }))

		// Tab 1 syncs once, goes offline, writes, and is closed.
		const tab1 = perTabDevice(server, tmp)
		await tab1.open()
		await tab1.sync()
		await tab1.disconnect()
		const note = await tab1.collection('notes').insert({ body: 'written in tab 1 while offline' })
		const tab1Node = tab1.getNodeId()
		await tab1.close()

		// Tab 2 (new node id, same database) comes online.
		const tab2 = perTabDevice(server, tmp)
		await tab2.open()
		cleanup.push(() => tab2.close())
		expect(tab2.getNodeId()).not.toBe(tab1Node)
		expect(await tab2.collection('notes').findById(note.id)).not.toBeNull()
		for (let i = 0; i < 3; i++) {
			await tab2.disconnect()
			await tab2.sync()
		}

		expect(server.getAllOperations().some((op) => op.recordId === note.id)).toBe(true)
	})
})
