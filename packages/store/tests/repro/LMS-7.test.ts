/**
 * LMS report #7 — follower RPC liveness probe is one-shot.
 *
 * Uses Node's real BroadcastChannel (no lock API; promotion is out of scope here, see
 * tests/repro/browser/LMS-5-6-7.browser.mjs LMS-7a/7b for the real-browser runs).
 * A fake leader relay answers pings until it "hangs" (stops answering anything).
 *
 * Asserts CORRECT behaviour; the first test FAILS on 1.0.0-beta.12.
 * Run: pnpm --filter @korajs/store exec vitest run tests/repro/LMS-7.test.ts
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { NoLeaderError, WorkerTimeoutError } from '../../src/errors'
import { FollowerBroadcastBridge } from '../../src/multi-tab/tab-storage'

const TIMEOUT_MS = 4000
const PROBE_MS = 200

let seq = 0
const open: Array<{ close(): void }> = []
afterEach(() => {
	for (const c of open.splice(0)) c.close()
})

function fakeLeader(channelName: string): { hang(): void; pings(): number } {
	const ch = new BroadcastChannel(channelName)
	open.push(ch)
	let hung = false
	let pings = 0
	ch.onmessage = (event: MessageEvent<{ type: string }>) => {
		if (hung) return
		if (event.data?.type === 'kora-leader-ping') {
			pings++
			ch.postMessage({ type: 'kora-leader-pong' })
		}
		// RPC requests are accepted but never answered (long-running / lost response).
	}
	return {
		hang: () => {
			hung = true
		},
		pings: () => pings,
	}
}

describe('LMS-7 follower liveness', () => {
	test('leader that hangs AFTER answering the first probe is detected well before the RPC timeout', async () => {
		const name = `lms7-${process.pid}-${seq++}`
		const leader = fakeLeader(name)
		const bridge = new FollowerBroadcastBridge(name, TIMEOUT_MS, PROBE_MS)
		open.push({ close: () => bridge.terminate() })

		const pending = bridge.send({ id: 1, type: 'query', sql: 'SELECT 1' }).then(
			() => ({ error: null as Error | null }),
			(error: Error) => ({ error }),
		)
		// Wait until the leader has really answered a probe (not a fixed sleep, which a
		// loaded CI runner can outlast before the first probe fires), then hang it.
		await vi.waitFor(() => expect(leader.pings()).toBeGreaterThanOrEqual(1), {
			timeout: TIMEOUT_MS,
			interval: 20,
		})
		leader.hang()
		const hungAt = Date.now()

		const { error } = await pending
		const sinceHang = Date.now() - hungAt
		// eslint-disable-next-line no-console
		console.log(
			`[LMS-7] settled ${sinceHang}ms after the hang with ${error?.name}; pings answered=${leader.pings()}`,
		)
		expect(error).toBeInstanceOf(NoLeaderError)
		// The guarantee: a leader that stops answering is detected by the probes, well
		// before the RPC timeout would fire (beta.12 waited for the full timeout). Measured
		// from the hang, with headroom for a loaded runner; still fails on beta.12.
		expect(sinceHang).toBeLessThan(TIMEOUT_MS / 2)
	}, 10_000)

	test('control: leader already dead before the request -> NoLeaderError after one probe (works today)', async () => {
		const name = `lms7-${process.pid}-${seq++}`
		const bridge = new FollowerBroadcastBridge(name, TIMEOUT_MS, PROBE_MS)
		open.push({ close: () => bridge.terminate() })
		const t0 = Date.now()
		const error = await bridge
			.send({ id: 1, type: 'query', sql: 'SELECT 1' })
			.catch((e: Error) => e)
		expect(error).toBeInstanceOf(NoLeaderError)
		expect(error).not.toBeInstanceOf(WorkerTimeoutError)
		expect(Date.now() - t0).toBeLessThan(PROBE_MS * 3 + 300)
	}, 10_000)
})
