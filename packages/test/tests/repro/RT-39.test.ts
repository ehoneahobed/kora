/**
 * RT-39 repro (Phase 2 red team, 2026-10-02): the one-time upgrade re-upload is
 * charged to the ingest rate limit op by op, although every re-uploaded op is a
 * stored duplicate the server acks without writing anything (RT-31). With the default
 * 600 ops/min and a device history of a few thousand operations:
 *
 * - every minute the session is ended with RATE_LIMIT (a session error: the engine
 *   disconnects and backs off), so downloads are interrupted too;
 * - the user's NEW writes are queued behind the whole history (the queue is in HLC
 *   order, the history is older) and reach the server only after it, minutes to hours
 *   after the upgrade. Every device of a fleet does this at once after the rollout.
 *
 * Asserts the CORRECT behaviour (fails today): after the upgrade a fresh write reaches
 * the server promptly and stored duplicates do not exhaust the ingest budget.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { KoraSyncServer, MemoryServerStore } from '@korajs/server'
import type { ServerTransport } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { StorageAdapter } from '@korajs/store'
import type { SyncTransport } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { TestDevice } from '../../src/test-device'
import type { TestServer } from '../../src/test-server'

const schema = defineSchema({
	version: 1,
	collections: { items: { fields: { n: t.number() } } },
})

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const fn of cleanup.reverse()) await fn()
	cleanup = []
})

describe('RT-39: upgrade re-upload exhausts the ingest rate limit', () => {
	test('a write made after the upgrade is not stuck behind rate-limited duplicates', async () => {
		const store = new MemoryServerStore()
		await store.setSchema(schema)
		// Before the upgrade: a server with a generous limit stores the device's history.
		let server = new KoraSyncServer({
			store,
			maxOpsPerMinute: 1_000_000,
			relayRetransmitIntervalMs: 0,
			deliveryPollIntervalMs: 0,
		})
		const errors: string[] = []
		const front = {
			handleConnection(transport: ServerTransport): string {
				return server.handleConnection({
					send: (m) => {
						if (m.type === 'error') errors.push((m as { code: string }).code)
						transport.send(m)
					},
					onMessage: (h) => transport.onMessage(h),
					onClose: (h) => transport.onClose(h),
					onError: (h) => transport.onError(h),
					isConnected: () => transport.isConnected(),
					close: (c, r) => transport.close(c, r),
				})
			},
		} as unknown as TestServer
		const tmp = mkdtempSync(join(tmpdir(), 'rt39-'))
		cleanup.push(() => rmSync(tmp, { recursive: true, force: true }))
		const d = new TestDevice({
			name: 'pos-terminal',
			schema,
			server: front,
			tmpDir: tmp,
			createTransportPair: () => {
				const pair = createServerTransportPair()
				return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
			},
		})
		await d.open()
		cleanup.push(() => d.close())
		for (let i = 0; i < 1500; i++) await d.collection('items').insert({ n: i })
		await d.sync()
		for (let i = 0; i < 10 && store.getAllOperations().length < 1500; i++) await d.sync()
		expect(store.getAllOperations()).toHaveLength(1500)
		await d.disconnect()
		await server.stop()

		// The upgrade: the server restarts with the default limit (600 ops/min); the
		// device has no recorded acknowledged prefix, so it re-uploads its history.
		server = new KoraSyncServer({ store, relayRetransmitIntervalMs: 0, deliveryPollIntervalMs: 0 })
		cleanup.push(() => server.stop())
		const adapter = (d as unknown as { adapter: StorageAdapter }).adapter
		await adapter.execute("DELETE FROM _kora_meta WHERE key = 'own_acked_through'")

		const fresh = await d.collection('items').insert({ n: -1 })
		for (let i = 0; i < 5; i++) {
			await d.disconnect()
			await d.sync()
		}

		expect({
			freshOnServer: store.getAllOperations().some((op) => op.recordId === fresh.id),
			rateLimited: errors.includes('RATE_LIMIT'),
		}).toEqual({ freshOnServer: true, rateLimited: false })
	}, 120_000)
})
