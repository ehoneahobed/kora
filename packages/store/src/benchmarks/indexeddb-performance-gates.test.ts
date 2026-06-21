import 'fake-indexeddb/auto'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { IndexedDbAdapter } from '../adapters/indexeddb-adapter'
import { MockWorkerBridge } from '../adapters/sqlite-wasm-mock-bridge'

const REGRESSION_FACTOR = 1.1
const INSERT_1K_LIMIT_MS = 10_000 * REGRESSION_FACTOR

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
})
