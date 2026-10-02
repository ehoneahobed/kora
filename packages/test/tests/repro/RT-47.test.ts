/**
 * RT-47 repro (Phase 2 red team round 2, 2026-10-02): the RT-36 terminal-rejection
 * marker is client-only and is not covered by the durability barrier. The upload is
 * made durable (sent flag) BEFORE the wire (RT-35), but the rejection that arrives later
 * is recorded in a write the device can still lose: the IndexedDB fallback's 500 ms
 * snapshot window (a reload right after the rejection), or a restored older copy (OS,
 * Electron/Tauri backup). The device then holds the op as "sent, unacknowledged" and
 * submits it again; the server re-judges it against today's state and applies a write it
 * refused (the RT-36 outcome). The server keeps no record of refused ids.
 *
 * The repro snapshots the device database while the server is judging the upload
 * (after the sent flag is durable, before the rejection reaches the device), restores it,
 * and lets the account balance recover.
 *
 * Asserts the CORRECT behaviour (fails today): a refused withdrawal stays refused.
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
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
	collections: { withdrawals: { fields: { amount: t.number() } } },
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

describe('RT-47: a terminal rejection lost with the tail of the local database', () => {
	test('a refused withdrawal is not resubmitted after the device restores an older copy', async () => {
		let balance = 50
		let snapshotDuringJudgement: (() => Promise<void>) | null = null
		const server = new TestServer(schema, {
			validateOperation: async (op) => {
				await snapshotDuringJudgement?.()
				snapshotDuringJudgement = null
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
		const dir = mkdtempSync(join(tmpdir(), 'rt47-'))
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
		const dbPath = join(dir, 'test-device-teller.db')
		const mk = () =>
			new TestDevice({ name: 'teller', schema, server, tmpDir: dir, createTransportPair: pair })

		const d1 = mk()
		await d1.open()
		await d1.sync()
		const adapter = (d1 as unknown as { adapter: { execute(sql: string): Promise<void> } }).adapter
		snapshotDuringJudgement = () => adapter.execute(`VACUUM INTO '${join(dir, 'snapshot.db')}'`)
		const refused = await d1.collection('withdrawals').insert({ amount: 100 })
		await d1.sync()
		await d1.sync()
		expect((await d1.getRejectedOperations()).map((r) => r.code)).toEqual(['INSUFFICIENT_FUNDS'])
		await d1.disconnect()
		await d1.close()
		rmSync(`${dbPath}-wal`, { force: true })
		rmSync(`${dbPath}-shm`, { force: true })
		copyFileSync(join(dir, 'snapshot.db'), dbPath)

		// Later the account has money again.
		balance = 1_000
		const d2 = mk()
		await d2.open()
		cleanup.push(() => d2.close())
		for (let i = 0; i < 3; i++) {
			await d2.disconnect()
			await d2.sync()
		}

		expect(server.getAllOperations().filter((op) => op.recordId === refused.id)).toHaveLength(0)
		expect(balance).toBe(1_000)
	}, 60_000)
})
