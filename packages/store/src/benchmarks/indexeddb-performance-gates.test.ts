import 'fake-indexeddb/auto'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { IndexedDbAdapter } from '../adapters/indexeddb-adapter'
import { MockWorkerBridge } from '../adapters/sqlite-wasm-mock-bridge'

const REGRESSION_FACTOR = 1.1
const INSERT_1K_LIMIT_MS = 10_000 * REGRESSION_FACTOR
const PERSIST_1K_LIMIT_MS = 1_000 * REGRESSION_FACTOR

describe('IndexedDB adapter performance gates', () => {
	let adapter: IndexedDbAdapter

	beforeEach(async () => {
		adapter = new IndexedDbAdapter({
			bridge: new MockWorkerBridge(),
			dbName: 'idb-perf-gate',
			persistenceDebounceMs: 0,
		})
		await adapter.open(minimalSchema)
	})

	afterEach(async () => {
		await adapter.close()
	})

	test('insert 1,000 records in one transaction under target', async () => {
		const startMs = performance.now()
		await adapter.transaction(async (tx) => {
			for (let index = 0; index < 1_000; index++) {
				await tx.execute(
					'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
					[`rec-${index}`, `todo-${index}`, index % 10 === 0 ? 1 : 0, 1000, 1000],
				)
			}
		})
		const elapsedMs = performance.now() - startMs

		expect(elapsedMs).toBeLessThan(INSERT_1K_LIMIT_MS)
	}, 30_000)

	test('persisting the 1,000-record snapshot (durability barrier) under target', async () => {
		// STORE-16: the snapshot write used to happen fire-and-forget outside the timed
		// window, so persistence cost was never measured. ensureDurable() resolves once
		// the committed writes are in IndexedDB. Node uses fake-indexeddb; the real
		// browser cost is measured by benchmarks/browser/store-browser-bench.mjs.
		await adapter.transaction(async (tx) => {
			for (let index = 0; index < 1_000; index++) {
				await tx.execute(
					'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
					// Distinct ids: the previous test's snapshot is restored into this database.
					[`persist-${index}`, `todo-${index}`, index % 10 === 0 ? 1 : 0, 1000, 1000],
				)
			}
		})
		const startMs = performance.now()
		await adapter.ensureDurable()
		const elapsedMs = performance.now() - startMs
		console.log(
			`[bench] IndexedDB snapshot persist (1,000 rows, fake-indexeddb): ${elapsedMs.toFixed(1)} ms`,
		)

		expect(elapsedMs).toBeLessThan(PERSIST_1K_LIMIT_MS)
	}, 30_000)
})

describe('IndexedDB fallback: awaited writes wait for their snapshot (A0 latency)', () => {
	// Offline-readiness design, section 8.1: every awaited write pays one snapshot (a full
	// export plus one IndexedDB put). Node uses fake-indexeddb and the mock worker, so these
	// numbers are a regression gate for the barrier path; the real cost (Chromium, real
	// IndexedDB with strict durability) is measured by benchmarks/browser/store-browser-bench.mjs
	// and has the target p95 < 250 ms at 10,000 records.
	async function measure(size: number, samples: number): Promise<{ p50: number; p95: number }> {
		const adapter = new IndexedDbAdapter({
			bridge: new MockWorkerBridge(),
			dbName: `idb-await-${size}`,
			persistenceDebounceMs: 500,
		})
		await adapter.open(minimalSchema)
		await adapter.transaction(async (tx) => {
			for (let index = 0; index < size; index++) {
				await tx.execute(
					'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
					[`seed-${index}`, `todo-${index}`, 0, 1000, 1000],
				)
			}
		})
		await adapter.ensureDurable()
		const times: number[] = []
		for (let index = 0; index < samples; index++) {
			const startMs = performance.now()
			await adapter.execute(
				'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
				[`await-${index}`, 'awaited', 0, 1000, 1000],
			)
			await adapter.ensureDurable()
			times.push(performance.now() - startMs)
		}
		await adapter.close()
		times.sort((a, b) => a - b)
		return {
			p50: times[Math.floor(times.length * 0.5)] ?? 0,
			p95: times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] ?? 0,
		}
	}

	test('awaited insert at 1,000 and 10,000 records', async () => {
		const small = await measure(1_000, 20)
		const large = await measure(10_000, 20)
		console.log(
			`[bench] idb awaited insert (node, fake-indexeddb): 1k p50=${small.p50.toFixed(1)}ms p95=${small.p95.toFixed(1)}ms; 10k p50=${large.p50.toFixed(1)}ms p95=${large.p95.toFixed(1)}ms`,
		)
		// Loose gate: catches an accidental O(n^2) or a second snapshot per write.
		expect(large.p95).toBeLessThan(2_000)
	}, 120_000)

	test('grouped writes pay one snapshot', async () => {
		const adapter = new IndexedDbAdapter({
			bridge: new MockWorkerBridge(),
			dbName: 'idb-await-group',
			persistenceDebounceMs: 500,
		})
		await adapter.open(minimalSchema)
		const startMs = performance.now()
		await Promise.all(
			Array.from({ length: 50 }, async (_, index) => {
				await adapter.execute(
					'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
					[`group-${index}`, 'g', 0, 1000, 1000],
				)
				await adapter.ensureDurable()
			}),
		)
		const elapsedMs = performance.now() - startMs
		console.log(`[bench] idb 50 concurrent awaited writes: ${elapsedMs.toFixed(1)}ms`)
		await adapter.close()
		expect(elapsedMs).toBeLessThan(5_000)
	}, 30_000)
})
