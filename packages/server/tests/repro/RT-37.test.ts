/**
 * RT-37 repro (Phase 2 red team, 2026-10-02): mixed versions. A beta.12 (or older) client still
 * allocates sequence numbers outside the commit (STORE-1 residual: two concurrent
 * `app.transaction` calls share one number; the S1 stopgap only fixed the serial case).
 * beta.12/13 servers stored both operations of such a pair. The Phase 2 server refuses
 * the second one with the NON-retriable SEQUENCE_CONFLICT whenever the first was stored
 * after the sequence-enforcement epoch, i.e. for every pair a beta.12 (or older) device creates
 * after the server upgrade. The beta.12 engine records the rejection and never sends
 * the write again: a write the user made is silently dropped from sync until that
 * device upgrades (and even then only resent by accident, see RT-36).
 *
 * Verified end to end with the unreleased Phase 1 client (build 33bca46) in
 * remediation/evidence/redteam-phase2.md; this repro drives the same upload at the
 * protocol level (what a beta.12 engine sends for such a pair).
 *
 * Asserts the CORRECT behaviour (fails today): an upload from a client that does not
 * advertise the W6 sequence guarantee is never terminally rejected for a duplicate
 * sequence; the write is kept (stored as a legacy pair, as beta.12 (and older) servers did).
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { batch, createHarness, makeOp, tick } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string() } } },
})

let stop: (() => Promise<void>) | null = null
afterEach(async () => {
	await stop?.()
	stop = null
})

describe('RT-37: beta.12 duplicate sequence pair against the Phase 2 server', () => {
	test('the second op of a pair created after the upgrade is not terminally rejected', async () => {
		const h = await createHarness(schema, null)
		stop = () => h.server.stop()
		const node = 'beta12-device'
		// beta.12 handshake: delivery watermark, no Phase 2 fields.
		const c = await h.login('', node, { lastDeliverySequence: 0 } as Partial<SyncMessage>)
		const x = makeOp(node, 1, { data: { title: 'x1' } })
		const y = makeOp(node, 1, { data: { title: 'y1' } }) // concurrent app.transaction
		c.send(batch([x, y]))
		await vi.waitFor(() => expect(c.messages.some((m) => m.type === 'acknowledgment')).toBe(true))
		await tick()

		const terminal = c.messages.filter(
			(m) => m.type === 'operation-rejected' && (m as { retriable?: boolean }).retriable === false,
		)
		const storedIds = (await h.store.getOperationsAfterDelivery(0, 100)).map(
			(entry) => entry.operation.id,
		)
		expect({ terminal: terminal.map((m) => (m as { code?: string }).code), storedIds }).toEqual({
			terminal: [],
			storedIds: expect.arrayContaining([x.id, y.id]),
		})
	})
})
