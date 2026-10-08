import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { SqliteWasmAdapter } from '../adapters/sqlite-wasm-adapter'
import { MockWorkerBridge } from '../adapters/sqlite-wasm-mock-bridge'
import { Store } from '../store/store'
import { expectTimingGate } from './timing-gate'

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
/** Most the adapter protocol may add to the direct native insert path (see the ratio test). */
const PROTOCOL_OVERHEAD_LIMIT = 0.25

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

		expectTimingGate('Adapter protocol: insert 10,000 records', elapsedMs, INSERT_10K_LIMIT_MS, {
			advisoryOnSharedRunner: true,
		})
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
		expectTimingGate('Adapter protocol: query 1,000 records', elapsedMs, QUERY_1K_LIMIT_MS)
	}, 30_000)

	test('protocol overhead over native SQLite stays bounded (machine-independent)', async () => {
		// The absolute insert gate above sits within the speed variance of shared CI
		// runners. This one compares the adapter protocol with the direct native adapter in
		// the same process, so it holds on any machine: the protocol may add at most
		// PROTOCOL_OVERHEAD_LIMIT to the direct path (fastest of three runs each,
		// interleaved).
		async function insertMs(adapter: BetterSqlite3Adapter | SqliteWasmAdapter): Promise<number> {
			const timed = new Store({ schema: minimalSchema, adapter, nodeId: 'ratio-node' })
			await timed.open()
			const started = performance.now()
			await timed.transaction(async (tx) => {
				const todosTx = tx.collection('todos')
				for (let index = 0; index < 10_000; index++) {
					await todosTx.insert({ title: `todo-${index}`, completed: index % 10 === 0 })
				}
			})
			const elapsed = performance.now() - started
			await timed.close()
			return elapsed
		}
		const direct: number[] = []
		const protocol: number[] = []
		for (let run = 0; run < 3; run++) {
			direct.push(await insertMs(new BetterSqlite3Adapter(':memory:')))
			protocol.push(
				await insertMs(
					new SqliteWasmAdapter({ bridge: new MockWorkerBridge(), dbName: `ratio-${run}` }),
				),
			)
		}
		const overhead = Math.min(...protocol) / Math.min(...direct) - 1
		const report = `Adapter protocol overhead over native: ${(overhead * 100).toFixed(1)}% (limit ${(PROTOCOL_OVERHEAD_LIMIT * 100).toFixed(0)}%)`
		if (process.env.GITHUB_ACTIONS === 'true') console.log(`::notice title=benchmark::${report}`)
		console.log(report)
		expect(overhead, report).toBeLessThan(PROTOCOL_OVERHEAD_LIMIT)
	}, 120_000)
})
