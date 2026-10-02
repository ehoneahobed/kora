/**
 * RT-43 repro (Phase 2 red team round 2, 2026-10-02): a device whose newest own
 * operation is acknowledged but NOT stored under its sequence number is told on every
 * handshake that the server holds fewer of its operations than its acknowledged prefix.
 * The engine reads that as "the server was restored from an older backup" and lowers
 * the prefix (`lowerOwnPrefixLocked`), so the tail is uploaded again, on every
 * reconnect, forever (until the device writes something newer).
 *
 * The plainest trigger is a validator that answers `{ action: 'ignore' }` (the server
 * "took responsibility out of band" and stores nothing): the ignored write is submitted
 * to the validator again on every reconnect, so its out-of-band effect (an email, a
 * charge, a webhook) repeats. A W6-renumbered own op stored under its old number has the
 * same shape (re-uploaded every reconnect as a free duplicate).
 *
 * Asserts the CORRECT behaviour (fails today): an acknowledged write is submitted once.
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

describe('RT-43: an acknowledged but unstored tail op is re-uploaded on every reconnect', () => {
	test('an op the validator ignored is submitted to the validator once', async () => {
		const calls = new Map<string, number>()
		const server = new TestServer(schema, {
			validateOperation: async (op) => {
				const body = String(op.data?.body ?? op.id)
				calls.set(body, (calls.get(body) ?? 0) + 1)
				// e.g. "send this message": handled out of band, nothing to store.
				return body.startsWith('send:') ? { action: 'ignore' } : { action: 'accept' }
			},
		})
		cleanup.push(() => server.close())
		const dir = mkdtempSync(join(tmpdir(), 'rt43-'))
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
		const device = new TestDevice({
			name: 'phone',
			schema,
			server,
			tmpDir: dir,
			createTransportPair: pair,
		})
		await device.open()
		cleanup.push(() => device.close())

		await device.sync()
		await device.collection('notes').insert({ body: 'stored note' })
		await device.collection('notes').insert({ body: 'send: invoice to customer' })
		await device.sync()
		expect(calls.get('send: invoice to customer')).toBe(1)

		for (let i = 0; i < 5; i++) {
			await device.disconnect()
			await device.sync()
		}

		expect({
			validatorCallsForIgnoredOp: calls.get('send: invoice to customer'),
			validatorCallsForStoredOp: calls.get('stored note'),
		}).toEqual({ validatorCallsForIgnoredOp: 1, validatorCallsForStoredOp: 1 })
	}, 60_000)
})
