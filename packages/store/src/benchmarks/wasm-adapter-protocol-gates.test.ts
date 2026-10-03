import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { SqliteWasmAdapter } from '../adapters/sqlite-wasm-adapter'
import { MockWorkerBridge } from '../adapters/sqlite-wasm-mock-bridge'
import { Store } from '../store/store'

/**
 * STORE-16: this is NOT a SQLite WASM or OPFS measurement. It runs the
 * SqliteWasmAdapter's request protocol (worker message encoding, transaction
 * spans) over MockWorkerBridge, which executes in-process on native
 * better-sqlite3: no WASM, no worker, no structured clone, no OPFS. It guards the
 * adapter-side overhead only. The real browser path (dedicated worker, SQLite
 * WASM, OPFS sahpool, IndexedDB snapshot persistence) is measured by
 * `benchmarks/browser/store-browser-bench.mjs`; see docs/benchmarks/baseline.md.
 */
const REGRESSION_FACTOR = 1.1
const INSERT_10K_LIMIT_MS = 2000 * REGRESSION_FACTOR
const QUERY_1K_LIMIT_MS = 50 * REGRESSION_FACTOR

describe('SqliteWasmAdapter protocol over MockWorkerBridge (native better-sqlite3, not WASM/OPFS)', () => {
	let store: Store

	beforeEach(async () => {
		const adapter = new SqliteWasmAdapter({
			bridge: new MockWorkerBridge(),
			dbName: 'wasm-perf-gate',
		})
		store = new Store({
			schema: minimalSchema,
			adapter,
			nodeId: 'wasm-bench-node',
		})
		await store.open()
	})

	afterEach(async () => {
		await store.close()
	})

	test('insert 10,000 records under target', async () => {
		const startMs = performance.now()
		await store.transaction(async (tx) => {
			const todosTx = tx.collection('todos')
			for (let index = 0; index < 10_000; index++) {
				await todosTx.insert({ title: `todo-${index}`, completed: index % 10 === 0 })
			}
		})
		const elapsedMs = performance.now() - startMs

		expect(elapsedMs).toBeLessThan(INSERT_10K_LIMIT_MS)
	}, 30_000)

	test('query 1,000 records with WHERE under target', async () => {
		await store.transaction(async (tx) => {
			const todosTx = tx.collection('todos')
			for (let index = 0; index < 10_000; index++) {
				await todosTx.insert({ title: `todo-${index}`, completed: index % 10 === 0 })
			}
		})

		const todos = store.collection('todos')
		const startMs = performance.now()
		const results = await todos.where({ completed: true }).exec()
		const elapsedMs = performance.now() - startMs

		expect(results.length).toBe(1000)
		expect(elapsedMs).toBeLessThan(QUERY_1K_LIMIT_MS)
	}, 30_000)
})
