/**
 * RT-36 repro (Phase 2 red team, 2026-10-02): an operation the server terminally
 * rejected is uploaded AGAIN whenever the device rescans its own log from a lower
 * acknowledged prefix: the one-time upgrade re-upload (no recorded prefix), and a
 * server that advertises fewer of the device's operations (restored backup) both
 * lower the prefix, and `scanOwnLog` enqueues every own op that is not queued and is
 * inside the uplink scope. It never consults the rejected store.
 *
 * The server judges the old operation again with today's state. A write it refused
 * (a validator's business rule, a constraint, an ownership check) is applied later,
 * possibly after the app already rolled it back or told the user it failed.
 *
 * Asserts the CORRECT behaviour (fails today).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { createServerTransportPair } from '@korajs/server/internal'
import type { StorageAdapter } from '@korajs/store'
import type { SyncTransport } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { TestDevice } from '../../src/test-device'
import { TestServer } from '../../src/test-server'

const schema = defineSchema({
	version: 1,
	collections: { withdrawals: { fields: { amount: t.number() } } },
})

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const fn of cleanup.reverse()) await fn()
	cleanup = []
})

describe('RT-36: a terminally rejected op is re-submitted by an own-log rescan', () => {
	test('upgrade re-upload must not resubmit an op the server already refused', async () => {
		let balance = 50
		const server = new TestServer(schema, {
			validateOperation: async (op) => {
				const amount = Number(op.data?.amount ?? 0)
				if (op.type === 'insert' && amount > balance) {
					return {
						action: 'reject',
						code: 'INSUFFICIENT_FUNDS',
						message: 'balance too low',
						retriable: false,
					}
				}
				if (op.type === 'insert') balance -= amount
				return { action: 'accept' }
			},
		})
		cleanup.push(() => server.close())
		const tmp = mkdtempSync(join(tmpdir(), 'rt36-'))
		cleanup.push(() => rmSync(tmp, { recursive: true, force: true }))
		const d = new TestDevice({
			name: 'teller',
			schema,
			server,
			tmpDir: tmp,
			createTransportPair: () => {
				const pair = createServerTransportPair()
				return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
			},
		})
		await d.open()
		cleanup.push(() => d.close())

		await d.sync()
		const refused = await d.collection('withdrawals').insert({ amount: 100 })
		await d.sync()
		await d.sync()
		expect((await d.getRejectedOperations()).map((r) => r.code)).toEqual(['INSUFFICIENT_FUNDS'])
		expect(server.getAllOperations()).toHaveLength(0)
		await d.disconnect()

		// Months later the account has money again.
		balance = 1_000

		// The device upgrades to this release: no acknowledged prefix recorded yet, so it
		// re-uploads its own history once (simulated exactly as the RT-31 repro does).
		const adapter = (d as unknown as { adapter: StorageAdapter }).adapter
		await adapter.execute("DELETE FROM _kora_meta WHERE key = 'own_acked_through'")
		await d.reconnect()
		for (let i = 0; i < 3; i++) await d.sync()

		// The refused withdrawal must stay refused.
		expect(server.getAllOperations().filter((op) => op.recordId === refused.id)).toHaveLength(0)
		expect(balance).toBe(1_000)
	})
})
