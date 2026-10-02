/**
 * RT-53 repro (Phase 2 red team round 3, 2026-10-02): a parked adoption (RT-46 fix) is
 * retried only when a session STARTS, or when this tab's own uploads make progress
 * (`maybeYieldToDeferredNode` needs `sessionAcked > 0`). Nothing ends a live, idle
 * session when the park's backoff runs out. A tab that stays connected and writes
 * nothing (a dashboard, a kiosk, a tab left open overnight) never retries the closed
 * tab's writes: they stay on this device only for as long as the connection holds,
 * although the condition that deferred them cleared seconds later.
 *
 * Here a closed tab's write is deferred once (retriable) by the server, then would be
 * accepted. The open tab stays connected and idle for longer than the 30 s backoff.
 *
 * Asserts the CORRECT behaviour (fails today): the closed tab's write reaches the server
 * once its park expired, without waiting for a reconnect or a write in the open tab.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { KoraEvent } from '@korajs/core'
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
	collections: { notes: { fields: { body: t.string() } } },
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

describe('RT-53: a parked adoption is never retried by an idle connected tab', () => {
	test("a closed tab's write deferred once reaches the server after the backoff", async () => {
		let attempts = 0
		const server = new TestServer(schema, {
			validateOperation: async (op) => {
				if (op.data?.body !== 'closed tab') return { action: 'accept' }
				attempts++
				// A transient condition (a parent from another device not there yet).
				if (attempts === 1) {
					return { action: 'reject', code: 'NOT_YET', message: 'try again later', retriable: true }
				}
				return { action: 'accept' }
			},
		})
		cleanup.push(() => server.close())
		const dir = mkdtempSync(join(tmpdir(), 'rt53-'))
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }))

		const closed = perTabDevice(server, dir)
		await closed.open()
		await closed.collection('notes').insert({ body: 'closed tab' })
		await closed.close()

		const open = perTabDevice(server, dir)
		await open.open()
		cleanup.push(() => open.close())
		const actions: string[] = []
		open.emitter.on('sync:local-node', (e: KoraEvent) => {
			if (e.type === 'sync:local-node') actions.push(e.action)
		})
		// First session adopts the closed tab's node; the server defers its write: parked.
		await open.sync()
		await open.disconnect()
		// The reconnect (ReconnectionManager in an app) runs as the open tab's own node.
		await open.sync()
		expect(actions).toContain('adoption-parked')

		// The open tab stays connected and idle past the 30 s park backoff.
		await new Promise((resolve) => setTimeout(resolve, 36_000))

		expect({
			onServer: server.getAllOperations().map((op) => String(op.data?.body)),
			attempts,
		}).toEqual({ onServer: ['closed tab'], attempts: 2 })
	}, 90_000)
})
