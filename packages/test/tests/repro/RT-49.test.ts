/**
 * RT-49 repro (Phase 2 red team round 2, 2026-10-02): when local persistence fails for
 * good (IndexedDB quota exceeded, storage evicted, a broken snapshot write), the RT-35
 * durability barrier stops ALL uploads: `sendUpload` returns the batch to the queue
 * (`UPLOAD_NOT_DURABLE`) and retries forever. The app keeps accepting writes into the
 * in-memory database, so everything written from then on exists only in that tab's
 * memory and is lost on reload, although the server was reachable the whole time and
 * Phase 2 can now recover a device's lost tail from the server (RT-35 resync). The
 * barrier turns "not durable locally" into "not durable anywhere".
 *
 * Simulated by making the store's durability barrier reject, as the IndexedDB adapter
 * does when the snapshot cannot be written.
 *
 * Asserts the CORRECT behaviour (fails today): with the server reachable, a write the
 * device cannot persist still reaches the server.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { ServerTransport } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
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

describe('RT-49: a permanent local persistence failure stops every upload', () => {
	test('writes made after the quota is exhausted still reach the reachable server', async () => {
		const server = new TestServer(schema)
		cleanup.push(() => server.close())
		const dir = mkdtempSync(join(tmpdir(), 'rt49-'))
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
		const device = new TestDevice({
			name: 'tab',
			schema,
			server,
			tmpDir: dir,
			createTransportPair: pair,
		})
		await device.open()
		cleanup.push(() => device.close())
		await device.sync()

		// IndexedDB snapshot writes now fail with QuotaExceededError.
		const store = device.store as unknown as { ensureDurable: () => Promise<void> }
		store.ensureDurable = async () => {
			const error = new Error('QuotaExceededError: the snapshot could not be written')
			error.name = 'QuotaExceededError'
			throw error
		}
		const persistenceErrors: string[] = []
		device.emitter.on('store:persistence-error', (e) => {
			if (e.type === 'store:persistence-error') persistenceErrors.push(e.code ?? '')
		})

		await device.collection('notes').insert({ body: 'written after the quota ran out' })
		for (let i = 0; i < 3; i++) {
			await device.disconnect()
			await device.sync()
		}

		// Today: UPLOAD_NOT_DURABLE events only, nothing on the server.
		expect(persistenceErrors).toContain('UPLOAD_NOT_DURABLE')
		expect(server.getAllOperations().map((op) => op.data?.body)).toEqual([
			'written after the quota ran out',
		])
	}, 60_000)
})
