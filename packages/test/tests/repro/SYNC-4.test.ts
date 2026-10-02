/**
 * SYNC-4 repro: in the default (non-strict) handshake, operations sent in the
 * handshake delta are removed from the outbound queue and counted as acknowledged
 * (lastAckedServerVector advanced to the local max) BEFORE the server acknowledges
 * them, and acks are never matched to the batch they answer. A retriable server
 * rejection therefore never gets retried; once any later local op is accepted the
 * server's max-sequence vector covers the gap and the op is lost permanently.
 * Asserts CORRECT behavior.
 */
import { defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { createTestNetwork } from '../../src/index'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

describe('SYNC-4: handshake-delta ops treated as acked before the server acks', () => {
	test('an op rejected retriably during the handshake delta is eventually stored on the server', async () => {
		let flakyAttempts = 0
		const network = await createTestNetwork(schema, {
			devices: 1,
			validateOperation: (op) => {
				if (op.data?.title === 'flaky' && flakyAttempts++ === 0) {
					return { action: 'reject', code: 'TRY_AGAIN', message: 'busy', retriable: true }
				}
				return { action: 'accept' }
			},
		})
		const [a] = network.devices
		if (!a) throw new Error('device')
		try {
			// Offline write, delivered via the handshake delta on first connect.
			const flaky = await a.collection('todos').insert({ title: 'flaky' })
			await a.sync()
			expect(flakyAttempts).toBe(1) // server rejected it retriably

			// A later write accepted while streaming raises the server vector past it.
			const later = await a.collection('todos').insert({ title: 'later' })
			await a.sync()
			const ids = () => network.server.getAllOperations().map((op) => op.recordId)
			expect(ids()).toContain(later.id)

			// Reconnect twice: the retriable op must be retried and accepted.
			await a.disconnect()
			await a.sync()
			await a.disconnect()
			await a.sync()
			expect(ids(), 'retriably-rejected handshake-delta op never retried').toContain(flaky.id)
		} finally {
			await network.close()
		}
	}, 30000)
})
