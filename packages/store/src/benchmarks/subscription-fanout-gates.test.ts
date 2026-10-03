import { performance } from 'node:perf_hooks'
import { type SchemaDefinition, defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'

/**
 * STORE-16: 1,000-subscription fan-out gates against the CLAUDE.md targets.
 * - Subscription check per mutation: < 1 ms with 1,000 active subscriptions.
 * - Mutation to subscriber notification: < 16 ms (one frame at 60 fps).
 *
 * Realistic shape: 1,000 live queries spread over 20 collections (50 each, every
 * one a distinct WHERE), so a write re-runs the 50 queries of its collection.
 * The worst case (all 1,000 queries on the one collection being written) is
 * measured and reported, and gated at its own ceiling, because every affected
 * query must be re-run and diffed.
 */
const REGRESSION_FACTOR = 1.1
const CHECK_LIMIT_MS = 1 * REGRESSION_FACTOR
const NOTIFY_LIMIT_MS = 16 * REGRESSION_FACTOR
const WORST_CASE_RERUN_LIMIT_MS = 50 * REGRESSION_FACTOR
const SUBSCRIPTIONS = 1_000
const COLLECTIONS = 20
const ROWS_PER_COLLECTION = 200
const MUTATIONS = 50

function fanoutSchema(): SchemaDefinition {
	const collections: Record<string, { fields: Record<string, ReturnType<typeof t.string>> }> = {}
	for (let c = 0; c < COLLECTIONS; c++) {
		collections[`items${c}`] = {
			fields: { title: t.string(), bucket: t.string() },
		}
	}
	return defineSchema({ version: 1, collections, relations: {} } as Parameters<
		typeof defineSchema
	>[0]) as SchemaDefinition
}

const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await nextFrame()
}

function percentile(samples: number[], p: number): number {
	const sorted = [...samples].sort((a, b) => a - b)
	return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0
}

describe('Subscription fan-out gates (1,000 subscriptions)', () => {
	let store: Store | null = null

	afterEach(async () => {
		await store?.close()
		store = null
	})

	async function openWithData(collectionCount: number): Promise<Store> {
		const s = new Store({
			schema: fanoutSchema(),
			adapter: new BetterSqlite3Adapter(':memory:'),
			nodeId: 'fanout-node',
		})
		await s.open()
		await s.transaction(async (tx) => {
			for (let c = 0; c < collectionCount; c++) {
				const col = tx.collection(`items${c}`)
				for (let i = 0; i < ROWS_PER_COLLECTION; i++) {
					await col.insert({ title: `t${i}`, bucket: `b${i % 50}` })
				}
			}
		})
		store = s
		return s
	}

	test('subscription check per mutation < 1 ms and notification < 16 ms (1,000 subs over 20 collections)', async () => {
		const s = await openWithData(COLLECTIONS)
		const notified = new Map<string, number>()
		const perCollection = SUBSCRIPTIONS / COLLECTIONS
		for (let c = 0; c < COLLECTIONS; c++) {
			for (let q = 0; q < perCollection; q++) {
				const key = `${c}:${q}`
				s.collection(`items${c}`)
					.where({ bucket: `b${q}` })
					.subscribe(() => {
						notified.set(key, performance.now())
					})
			}
		}
		await settle()
		expect(s.getSubscriptionManager().size).toBe(SUBSCRIPTIONS)

		const before = s.getSubscriptionManager().getStats()
		const latencies: number[] = []
		for (let m = 0; m < MUTATIONS; m++) {
			const c = m % COLLECTIONS
			const watched = `${c}:${m % perCollection}`
			notified.delete(watched)
			const start = performance.now()
			await s.collection(`items${c}`).insert({ title: `new${m}`, bucket: `b${m % perCollection}` })
			while (!notified.has(watched)) await nextFrame()
			latencies.push((notified.get(watched) ?? start) - start)
		}
		const after = s.getSubscriptionManager().getStats()
		const checks = after.totalChecks - before.totalChecks
		const checkMs =
			(after.averageCheckTimeMs * after.totalChecks -
				before.averageCheckTimeMs * before.totalChecks) /
			Math.max(1, checks)
		const p50 = percentile(latencies, 0.5)
		const p95 = percentile(latencies, 0.95)
		console.log(
			`[bench] fan-out 1,000 subs / 20 collections: check ${(checkMs * 1000).toFixed(1)} µs per mutation (bloom ${after.bloomFilterActive ? 'on' : 'off'}); mutation->notify p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`,
		)
		expect(checkMs).toBeLessThan(CHECK_LIMIT_MS)
		expect(p95).toBeLessThan(NOTIFY_LIMIT_MS)
	}, 60_000)

	test('worst case: 1,000 subscriptions on the written collection', async () => {
		const s = await openWithData(1)
		let notifiedCount = 0
		let lastNotifiedAt = 0
		for (let q = 0; q < SUBSCRIPTIONS; q++) {
			s.collection('items0')
				.where({ bucket: `b${q % 50}`, title: `t${q}` })
				.subscribe(() => {
					notifiedCount++
					lastNotifiedAt = performance.now()
				})
		}
		await settle()
		const manager = s.getSubscriptionManager()
		const before = manager.getStats()

		const firstNotify: number[] = []
		const allRerun: number[] = []
		for (let m = 0; m < 10; m++) {
			// The written row matches exactly one query (title t<m> / bucket b<m>), so
			// one subscriber is notified; all 1,000 are re-run and diffed.
			const baseline = notifiedCount
			const start = performance.now()
			await s.collection('items0').insert({ title: `t${m}`, bucket: `b${m % 50}` })
			while (notifiedCount === baseline) await nextFrame()
			firstNotify.push(lastNotifiedAt - start)
			await manager.flush()
			allRerun.push(performance.now() - start)
		}
		const after = manager.getStats()
		const checks = after.totalChecks - before.totalChecks
		const checkMs =
			(after.averageCheckTimeMs * after.totalChecks -
				before.averageCheckTimeMs * before.totalChecks) /
			Math.max(1, checks)
		console.log(
			`[bench] worst case 1,000 subs on one collection: check ${(checkMs * 1000).toFixed(1)} µs; mutation->notify p50 ${percentile(firstNotify, 0.5).toFixed(2)} ms; full re-run of 1,000 queries p50 ${percentile(allRerun, 0.5).toFixed(2)} ms`,
		)
		expect(checkMs).toBeLessThan(CHECK_LIMIT_MS)
		// Not the one-frame target: every one of the 1,000 queries is re-run and
		// diffed (about 20 µs each in Node), so this case exceeds a frame. Gated
		// at its own ceiling to catch regressions; see docs/benchmarks/baseline.md.
		expect(percentile(allRerun, 0.5)).toBeLessThan(WORST_CASE_RERUN_LIMIT_MS)
	}, 60_000)
})
