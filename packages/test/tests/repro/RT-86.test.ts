/**
 * RT-86 repro (Phase 3 red team round 4, 2026-10-03): a local write larger than the
 * server's `maxOperationBytes` (default 256 KiB) is accepted by the API, and then wedges
 * the device's whole upload stream for good.
 *
 * The client never checks an operation's size. The server answers an oversized upload
 * with a session-level `error` (`OPERATION_TOO_LARGE`) and stops acknowledging the
 * batch (`canAdvanceAck = false`), instead of a per-operation refusal. The device keeps
 * the operation at the head of its queue and re-sends it on every session, so no later
 * write of that device ever reaches the server or a peer, and nothing tells the app
 * which write is at fault (the round-4 rule: a write the API accepts locally but the
 * server refuses must surface, never silently vanish or wedge).
 * Not a round-4 regression.
 *
 * Asserts the CORRECT behaviour (fails at 5498764): either the API refuses the oversized
 * write up front, or the server refuses that one operation terminally; the device's
 * next, ordinary write reaches the peer.
 */
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { type TestDevice, createTestNetwork } from '../../src/index'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), body: t.string().optional() } } },
}) as unknown as SchemaDefinition

describe('RT-86: an oversized local write wedges the device upload stream', () => {
	test('a 300 KiB note, then a small one: the small one reaches the peer', async () => {
		const network = await createTestNetwork(schema, { devices: 2 })
		try {
			const [a, b] = network.devices as [TestDevice, TestDevice]
			try {
				await a.collection('notes').insert({ title: 'big', body: 'x'.repeat(300 * 1024) })
			} catch {
				// Refusing the oversized write up front is a correct outcome.
			}
			await a.collection('notes').insert({ title: 'small' })
			for (let i = 0; i < 3; i++) {
				// A new session each round: the device re-sends its queue every time.
				await a.reconnect().catch(() => {})
				await a.sync().catch(() => {})
				await b.sync().catch(() => {})
			}
			const titles = (await b.getState('notes')).map((r) => r.title)
			// Fails: nothing after the oversized op is ever uploaded.
			expect(titles).toContain('small')
		} finally {
			await network.close()
		}
	}, 60_000)
})
