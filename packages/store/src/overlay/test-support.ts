import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import type { Transaction } from '../types'

/*
 * Test and benchmark support for the instant-UI overlay (S3). Not exported from the
 * package: it exists so the equivalence property and the Node gates drive the same
 * controllable adapter.
 */

/** One write transaction waiting before its COMMIT. */
export interface Gate {
	/** Let the transaction commit. */
	release(): void
	/** Make the transaction fail (and roll back). */
	fail(): void
}

/**
 * better-sqlite3 whose write transactions wait before COMMIT until the test says so.
 *
 * The wait sits INSIDE the adapter's transaction mutex, so transactions keep the order the
 * writes were called in (as in production) and reads queue behind a waiting write. What a
 * test controls is when each commit lands relative to everything queued behind it.
 */
export class GatedAdapter extends BetterSqlite3Adapter {
	/** Gate transactions (off while a test sets up its data). */
	gating = false
	/** Open every gate as it is created (the drain at the end of a test). */
	autoRelease = false
	/** Gates not yet released, in transaction order. */
	readonly gates: Gate[] = []
	/**
	 * Wait at the gate BEFORE the transaction body runs instead of before COMMIT. A failed
	 * gate is then a failure inside the transaction before any statement (no M2 lookup: the
	 * body never finished), which rejects without touching the adapter again.
	 */
	gateBeforeBody = false

	override async transaction(fn: (tx: Transaction) => Promise<void>): Promise<void> {
		if (!this.gating) return super.transaction(fn)
		let release: () => void = () => {}
		let reject: (error: Error) => void = () => {}
		const wait = new Promise<void>((resolve, rejectWith) => {
			release = resolve
			reject = rejectWith
		})
		// Failing a gate nobody awaits yet must not be an unhandled rejection.
		wait.catch(() => {})
		const gate: Gate = { release, fail: () => reject(new Error('injected: commit failed')) }
		this.gates.push(gate)
		if (this.autoRelease) gate.release()
		const before = this.gateBeforeBody
		return super.transaction(async (tx) => {
			if (before) await wait
			await fn(tx)
			if (!before) await wait
		})
	}
}

/** Let every ready microtask and in-process promise chain run to quiescence (no timers). */
export async function quiesce(): Promise<void> {
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}
