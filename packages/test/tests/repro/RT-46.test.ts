/**
 * RT-46 repro (Phase 2 red team round 2, 2026-10-02): per-tab adoption (RT-40) is
 * head-of-line blocking. A starting engine adopts ONE orphaned local node, runs the whole
 * session as that node (`takeBatch(isSessionOperation)` uploads nothing else), and ends
 * the adoption only when every one of its writes is acknowledged
 * (`maybeEndSessionForNodeWork`). Every new session picks the same node again
 * (`chooseSessionNode`, registry order).
 *
 * So one adopted write the server keeps answering with a RETRIABLE rejection (a
 * validator that defers until a referenced record exists, `retriable: true`; a throwing
 * validator; RATE_LIMIT) stalls every other upload from this browser profile: the live
 * tab's own writes and the other orphaned nodes. With two closed tabs where the
 * EARLIER node holds a child and the later node its parent, nothing ever syncs again
 * from a single remaining tab: the child waits for the parent, the parent's node is
 * never adopted, and the tab's own writes wait for both. Nothing reports it beyond a
 * pending count.
 *
 * Asserts the CORRECT behaviour (fails today): the adopting tab's own write and the
 * other orphan's parent reach the server, and the child follows.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { ServerTransport } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import { Store } from '@korajs/store'
import type { StorageAdapter } from '@korajs/store'
import type { SyncTransport } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { TestDevice } from '../../src/test-device'
import { TestServer } from '../../src/test-server'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { body: t.string(), parentBody: t.string().optional() } },
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

describe('RT-46: adoption of one orphaned node blocks every other upload', () => {
	test('a child waiting for its parent on another orphan node stalls all uploads', async () => {
		const storedBodies = new Set<string>()
		const server: TestServer = new TestServer(schema, {
			// "A child is accepted once its parent is on the server; retry later."
			validateOperation: async (op) => {
				const parent = op.data?.parentBody
				if (typeof parent === 'string' && !storedBodies.has(parent)) {
					return {
						action: 'reject',
						code: 'PARENT_NOT_YET_SYNCED',
						message: 'parent not on the server yet',
						retriable: true,
					}
				}
				if (typeof op.data?.body === 'string') storedBodies.add(op.data.body)
				return { action: 'accept' }
			},
		})
		cleanup.push(() => server.close())
		const dir = mkdtempSync(join(tmpdir(), 'rt46-'))
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }))

		// Tab 1 opens first (older node id), tab 2 second. Both offline.
		const tab1 = perTab(server, dir)
		await tab1.open()
		const tab2 = perTab(server, dir)
		await tab2.open()
		// Tab 2 creates a project; tab 1 adds a task to it (shared database).
		await tab2.collection('notes').insert({ body: 'project' })
		await tab1.collection('notes').insert({ body: 'task', parentBody: 'project' })
		await tab1.close()
		await tab2.close()

		// One tab remains open; it writes and goes online.
		const tab3 = perTab(server, dir)
		await tab3.open()
		cleanup.push(() => tab3.close())
		await tab3.collection('notes').insert({ body: 'written in the open tab' })
		for (let i = 0; i < 6; i++) {
			await tab3.disconnect()
			await tab3.sync()
		}

		const onServer = server
			.getAllOperations()
			.map((op) => String(op.data?.body ?? ''))
			.sort()
		expect(onServer).toEqual(['project', 'task', 'written in the open tab'])
	}, 60_000)
})
