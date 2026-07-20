import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { TestDevice, TestNetwork } from '../src/index'
import {
	createTestNetwork,
	expectConvergedEventually,
	wrapTransportPairWithServerClock,
} from '../src/index'

/**
 * End-to-end clock-integrity flow across store + sync + server:
 *
 *  1. A device whose clock is fast queues operations offline, then connects to a
 *     server whose clock is correct → sync blocks with `clock-error`.
 *  2. The clock is corrected and the device reconnects → the queued operations
 *     are rebased through the real Store.rebaseUnsyncedOperations path wired into
 *     the sync engine, and sync to the server under valid timestamps.
 *  3. A second client converges to the same state.
 *
 * The fast clock is simulated by mocking `Date.now()` on the device while a
 * transport wrapper injects the server's true time into the handshake, so the
 * skew the engine measures is real even though both run in one process.
 */

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				done: t.boolean().default(false),
			},
		},
	},
})

/** Captured before any Date.now mock so it always yields the real wall clock. */
const REAL_NOW: () => number = Date.now.bind(Date)
const CLOCK_AHEAD_MS = 10 * 60_000
const SERVER_FUTURE_TOLERANCE_MS = 60_000

let network: TestNetwork | null = null

afterEach(async () => {
	if (network) {
		await network.close()
		network = null
	}
})

function devices(...indices: number[]): TestDevice[] {
	return indices.map((i) => {
		const d = network?.devices[i]
		if (!d) throw new Error(`Device at index ${i} not found`)
		return d
	})
}

describe('Clock integrity: skew detection, block, rebase, convergence', () => {
	test('fast clock blocks sync, then queued ops rebase and converge after correction', async () => {
		// The server always reports its true wall clock, independent of the
		// device's mocked Date.now().
		network = await createTestNetwork(schema, {
			devices: 2,
			wrapTransport: (pair) => wrapTransportPairWithServerClock(pair, REAL_NOW),
		})
		const [fast, other] = devices(0, 1)

		// --- Phase 1: device clock runs fast; queue several ops offline. ---
		const clockSpy = vi.spyOn(Date, 'now').mockImplementation(() => REAL_NOW() + CLOCK_AHEAD_MS)
		try {
			await fast.collection('todos').insert({ title: 'first' })
			await fast.collection('todos').insert({ title: 'second' })
			await fast.collection('todos').insert({ title: 'third' })

			// Connect while the clock is still fast → sync must block.
			await fast.sync()

			// (1) Sync enters clock-error and blocks while the clock is fast.
			const engine = fast.getSyncEngine()
			expect(engine?.isClockBlocked()).toBe(true)
			expect(engine?.getStatus().status).toBe('clock-error')
			// Blocked before the delta exchange → nothing reached the server.
			expect(network.server.getAllOperations()).toHaveLength(0)
		} finally {
			clockSpy.mockRestore()
		}

		// --- Phase 2: clock corrected (Date.now real again); reconnect. ---
		let rebaseEvents = 0
		fast.emitter.on('sync:clock-rebase', () => {
			rebaseEvents++
		})

		await fast.disconnect()
		await fast.sync()

		// (2) The queued operations were rebased and successfully synced.
		expect(rebaseEvents).toBeGreaterThan(0)
		expect(fast.getSyncEngine()?.isClockBlocked()).toBe(false)
		expect(fast.getSyncEngine()?.getStatus().status).not.toBe('clock-error')
		expect(network.server.getAllOperations()).toHaveLength(3)

		// (3) The server holds only valid (non-future) timestamps.
		const futureLimit = REAL_NOW() + SERVER_FUTURE_TOLERANCE_MS
		for (const op of network.server.getAllOperations()) {
			expect(op.timestamp.wallTime).toBeLessThanOrEqual(futureLimit)
		}

		// (4) A second client converges to the same state.
		await other.sync()
		await expectConvergedEventually([fast, other], schema, { timeoutMs: 8000 })
		const otherTodos = await other.getState('todos')
		expect(otherTodos).toHaveLength(3)
		expect(otherTodos.map((r) => (r as Record<string, unknown>).title).sort()).toEqual([
			'first',
			'second',
			'third',
		])
	}, 30000)
})
