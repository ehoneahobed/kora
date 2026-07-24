import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { type TestNetwork, createTestNetwork } from '../src/index'

/**
 * Two-device convergence for the server-side operation validation subsystem.
 *
 * Proves the acceptance criteria: an untrusted client operation is adjudicated
 * server-side before it becomes authoritative. An accepted op converges to every
 * device; a rejected op never enters the authoritative log (no divergence across
 * synced devices) and is preserved + explained on the submitter (no loss).
 */
const schema = defineSchema({
	version: 1,
	collections: {
		submissions: {
			fields: {
				text: t.string(),
			},
		},
	},
})

// Policy: reject anything that looks like spam, accept everything else.
function rejectSpam() {
	return (op: { data: Record<string, unknown> | null }) => {
		const text = (op.data as { text?: string } | null)?.text
		if (text === 'spam') {
			return { action: 'reject' as const, code: 'SPAM', message: 'Submission looks like spam' }
		}
		return { action: 'accept' as const }
	}
}

describe('operation validation convergence', () => {
	let network: TestNetwork

	afterEach(async () => {
		await network?.close()
	})

	test('an accepted submission converges to the other device', async () => {
		network = await createTestNetwork(schema, { devices: 2, validateOperation: rejectSpam() })
		const [deviceA, deviceB] = network.devices
		if (!deviceA || !deviceB) throw new Error('expected two devices')

		await deviceA.collection('submissions').insert({ text: 'a real answer' })
		await deviceA.sync()
		await deviceB.sync()

		const onB = await deviceB.getState('submissions')
		expect(onB).toHaveLength(1)
		expect(onB[0]?.text).toBe('a real answer')
		// Nothing was rejected.
		expect(await deviceA.getRejectedOperations()).toHaveLength(0)
	})

	test('a rejected submission never becomes authoritative and is kept + explained on the submitter', async () => {
		network = await createTestNetwork(schema, { devices: 2, validateOperation: rejectSpam() })
		const [deviceA, deviceB] = network.devices
		if (!deviceA || !deviceB) throw new Error('expected two devices')

		// A optimistically writes locally, then syncs; the server rejects it.
		const spam = await deviceA.collection('submissions').insert({ text: 'spam' })
		await deviceA.sync()

		// No loss: the rejection is recorded on the submitter, tied to the op, with a
		// structured, explainable reason.
		const rejected = await deviceA.getRejectedOperations()
		expect(rejected).toHaveLength(1)
		expect(rejected[0]?.collection).toBe('submissions')
		expect(rejected[0]?.recordId).toBe(spam.id)
		expect(rejected[0]?.code).toBe('SPAM')
		expect(rejected[0]?.retriable).toBe(false)

		// Never authoritative: the server holds no operation for it.
		const serverOps = network.server.getAllOperations()
		expect(serverOps.some((op) => op.recordId === spam.id)).toBe(false)

		// No divergence across synced devices: B never sees the rejected submission.
		await deviceB.sync()
		const onB = await deviceB.getState('submissions')
		expect(onB.some((r) => r.id === spam.id)).toBe(false)

		// The submitter's own optimistic copy is still present and reconcilable — the
		// framework surfaces the rejection rather than silently rolling back, so the
		// app decides whether to delete it or resubmit a corrected op.
		const onA = await deviceA.getState('submissions')
		expect(onA.some((r) => r.id === spam.id)).toBe(true)
	})

	test('a rejected op is not resent on a later sync, and convergence stays stable', async () => {
		network = await createTestNetwork(schema, { devices: 2, validateOperation: rejectSpam() })
		const [deviceA, deviceB] = network.devices
		if (!deviceA || !deviceB) throw new Error('expected two devices')

		const spam = await deviceA.collection('submissions').insert({ text: 'spam' })
		await deviceA.sync()
		expect(await deviceA.getRejectedOperations()).toHaveLength(1)

		// A follow-up valid submission still syncs and converges, proving the
		// rejection did not wedge the connection.
		const good = await deviceA.collection('submissions').insert({ text: 'a valid one' })
		await deviceA.sync()
		await deviceB.sync()

		const onB = await deviceB.getState('submissions')
		expect(onB.map((r) => r.id)).toContain(good.id)
		expect(onB.some((r) => r.id === spam.id)).toBe(false)

		// The server only ever stored the accepted op.
		const serverOps = network.server.getAllOperations()
		expect(serverOps.some((op) => op.recordId === good.id)).toBe(true)
		expect(serverOps.some((op) => op.recordId === spam.id)).toBe(false)
	})
})
