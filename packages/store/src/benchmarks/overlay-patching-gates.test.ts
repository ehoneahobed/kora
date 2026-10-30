import { performance } from 'node:perf_hooks'
import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import type { PendingWrites } from '../overlay/pending-writes'
import { GatedAdapter, quiesce } from '../overlay/test-support'
import { Store } from '../store/store'
import { expectTimingGate } from './timing-gate'

/**
 * Node gates for instant-UI stage S3 (docs/design/instant-ui-updates.md 13, S3):
 *
 * - write to subscriber callback under 2 ms while the write's commit is still pending;
 * - one write patched into 1,000 subscriptions of 100 rows each (all on the written
 *   collection, all affected) in under 8 ms.
 *
 * The commit is held at a gate for the whole measurement, so the callback demonstrably
 * arrives BEFORE any commit work, however long the commit would take (the design's 50 ms is
 * the OPFS commit: the gate stays closed for the entire window, so the figure does not
 * depend on it). No sleeps: the gate opens when the measurement is done. The browser
 * numbers (OPFS, worker round trips) are the S5 gates; these measure the main-thread cost
 * of the patch itself, which is what S3 adds.
 */
const CALLBACK_LIMIT_MS = 2
const FANOUT_LIMIT_MS = 8
const SINGLE_SAMPLES = 40
const FANOUT_SAMPLES = 20
const WARMUP = 5

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: { title: t.string(), completed: t.boolean().default(false), bucket: t.string() },
		},
		items: { fields: { title: t.string(), bucket: t.string() } },
	},
})

function percentile(samples: number[], p: number): number {
	const sorted = [...samples].sort((a, b) => a - b)
	return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0
}

/** Await microtasks until `done()`; the patch pass is a microtask, so this never sleeps. */
async function untilTrue(done: () => boolean, limit = 200): Promise<void> {
	for (let i = 0; i < limit && !done(); i++) await Promise.resolve()
}

async function settleAll(registry: PendingWrites): Promise<void> {
	for (let i = 0; i < 100 && registry.list().length > 0; i++) await quiesce()
}

describe('Overlay patching gates (Node)', () => {
	let store: Store | null = null

	afterEach(async () => {
		await store?.close()
		store = null
	})

	async function open(): Promise<{ s: Store; adapter: GatedAdapter; registry: PendingWrites }> {
		const adapter = new GatedAdapter(':memory:')
		const s = new Store({
			schema,
			adapter,
			nodeId: 'gate-node',
			instantUpdates: true,
			// A read the write path may not wait on: an update with no known base is not predicted.
			instantUpdatesInternals: { readRecord: async () => null },
		})
		await s.open()
		store = s
		const controller = s.getOverlayController()
		if (!controller) throw new Error('the store was built without an overlay')
		return { s, adapter, registry: controller.registry }
	}

	for (const ordered of [false, true]) {
		test(`write to callback < 2 ms with the commit pending (1,000-row result${ordered ? ', ordered by createdAt' : ''})`, async () => {
			const { s, adapter, registry } = await open()
			await s.transaction(async (tx) => {
				const col = tx.collection('todos')
				for (let i = 0; i < 1_000; i++) {
					await col.insert({ title: `t${i}`, completed: true, bucket: `b${i % 50}` })
				}
			})
			let fired = 0
			let rows = 0
			let query = s.collection('todos').where({ completed: true })
			if (ordered) query = query.orderBy('createdAt', 'asc')
			query.subscribe((result) => {
				fired = performance.now()
				rows = result.length
			})
			await quiesce()
			expect(rows).toBe(1_000)
			adapter.gating = true

			const latencies: number[] = []
			for (let i = 0; i < WARMUP + SINGLE_SAMPLES; i++) {
				fired = 0
				const before = rows
				const startedAt = performance.now()
				const write = s
					.collection('todos')
					.insert({ title: `new${i}`, completed: true, bucket: 'b0' })
				await untilTrue(() => fired !== 0)
				// Deterministic part of the gate: shown while the commit has not happened.
				expect(fired, 'the callback must arrive before the commit').not.toBe(0)
				expect(adapter.gates.length, 'the commit is still pending').toBe(1)
				expect(rows).toBe(before + 1)
				if (i >= WARMUP) latencies.push(fired - startedAt)
				adapter.gates.shift()?.release()
				await write
				await settleAll(registry)
			}
			const p50 = percentile(latencies, 0.5)
			const p95 = percentile(latencies, 0.95)
			console.log(
				`[bench] overlay write->callback, 1,000 rows${ordered ? ' ordered' : ''}, commit pending: p50 ${p50.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms`,
			)
			expectTimingGate(
				`overlay write->callback p95 (1,000 rows${ordered ? ', ordered' : ''})`,
				p95,
				CALLBACK_LIMIT_MS,
				{ advisoryOnSharedRunner: true },
			)
		}, 60_000)
	}

	test('one write patched into 1,000 subscriptions of 100 rows in < 8 ms', async () => {
		const { s, adapter, registry } = await open()
		await s.transaction(async (tx) => {
			const col = tx.collection('items')
			for (let i = 0; i < 100; i++) await col.insert({ title: `t${i}`, bucket: `b${i % 10}` })
		})
		let received = 0
		let lastAt = 0
		for (let q = 0; q < 1_000; q++) {
			// Distinct queries that all contain the written row: three shapes (insertion order,
			// by title, by createdAt descending), each with its own excluded bucket.
			let query = s.collection('items').where({ bucket: { $ne: `none${q}` } })
			if (q % 3 === 1) query = query.orderBy('title', 'asc').orderBy('id', 'asc')
			if (q % 3 === 2) query = query.orderBy('createdAt', 'desc').orderBy('id', 'desc')
			query.subscribe(() => {
				received++
				lastAt = performance.now()
			})
		}
		await quiesce()
		expect(s.getSubscriptionManager().size).toBe(1_000)
		adapter.gating = true

		const latencies: number[] = []
		const passes: number[] = []
		let skipsBefore = 0
		for (let i = 0; i < WARMUP + FANOUT_SAMPLES; i++) {
			if (i === WARMUP) skipsBefore = s.getSubscriptionManager().getOverlayStats().budgetSkips
			received = 0
			lastAt = 0
			const startedAt = performance.now()
			const write = s.collection('items').insert({ title: `new${i}`, bucket: 'b0' })
			await untilTrue(() => received === 1_000, 2_000)
			expect(adapter.gates.length, 'the commit is still pending').toBe(1)
			// The warm-up passes run cold (JIT) and may hit the 8 ms budget. A measured pass
			// that does left subscriptions to the commit path: that sample missed the gate
			// (infinite latency), and the p95 tolerates one such outlier in 20.
			if (i >= WARMUP) {
				latencies.push(received === 1_000 ? lastAt - startedAt : Number.POSITIVE_INFINITY)
				passes.push(s.getSubscriptionManager().getOverlayStats().lastPassMs)
			}
			adapter.gates.shift()?.release()
			await write
			await settleAll(registry)
		}
		const stats = s.getSubscriptionManager().getOverlayStats()
		const p50 = percentile(latencies, 0.5)
		const p95 = percentile(latencies, 0.95)
		console.log(
			`[bench] overlay fan-out, 1,000 subscriptions x 100 rows, commit pending: write->last callback p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms pass alone p50 ${percentile(passes, 0.5).toFixed(2)} ms, p95 ${percentile(passes, 0.95).toFixed(2)} ms (budget skips while measured: ${stats.budgetSkips - skipsBefore})`,
		)
		expectTimingGate('overlay fan-out p95 (1,000 subscriptions)', p95, FANOUT_LIMIT_MS, {
			advisoryOnSharedRunner: true,
		})
	}, 120_000)
})
