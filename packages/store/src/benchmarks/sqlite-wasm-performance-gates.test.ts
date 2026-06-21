import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { SqliteWasmAdapter } from '../adapters/sqlite-wasm-adapter'
import { MockWorkerBridge } from '../adapters/sqlite-wasm-mock-bridge'
import { Store } from '../store/store'

/**
 * WASM adapter gates use MockWorkerBridge (better-sqlite3 in-process) in CI.
 * Browser OPFS runs the same adapter surface with a real worker; see docs/benchmarks/baseline.md.
 */
const REGRESSION_FACTOR = 1.1
const INSERT_10K_LIMIT_MS = 2000 * REGRESSION_FACTOR
const QUERY_1K_LIMIT_MS = 50 * REGRESSION_FACTOR

describe('SQLite WASM adapter performance gates', () => {
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
