import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'

const REGRESSION_FACTOR = 1.1
const INSERT_10K_LIMIT_MS = 2000 * REGRESSION_FACTOR
const QUERY_1K_LIMIT_MS = 50 * REGRESSION_FACTOR
const REACTIVE_NOTIFY_LIMIT_MS = 16 * REGRESSION_FACTOR

describe('Store performance gates', () => {
	let store: Store

	beforeEach(async () => {
		store = new Store({
			schema: minimalSchema,
			adapter: new BetterSqlite3Adapter(':memory:'),
			nodeId: 'bench-node',
		})
		await store.open()
	})

	afterEach(async () => {
		await store.close()
	})

	test('insert 10,000 records under target', async () => {
		const todos = store.collection('todos')

		const startMs = performance.now()
		for (let index = 0; index < 10_000; index++) {
			await todos.insert({ title: `todo-${index}`, completed: index % 10 === 0 })
		}
		const elapsedMs = performance.now() - startMs

		expect(elapsedMs).toBeLessThan(INSERT_10K_LIMIT_MS)
	}, 30_000)

	test('query 1,000 records with WHERE under target', async () => {
		const todos = store.collection('todos')

		for (let index = 0; index < 10_000; index++) {
			await todos.insert({ title: `todo-${index}`, completed: index % 10 === 0 })
		}

		const startMs = performance.now()
		const results = await todos.where({ completed: true }).exec()
		const elapsedMs = performance.now() - startMs

		expect(results.length).toBe(1000)
		expect(elapsedMs).toBeLessThan(QUERY_1K_LIMIT_MS)
	}, 30_000)

	test('reactive query notification latency under target', async () => {
		const todos = store.collection('todos')
		const query = todos.where({ completed: true })

		let notificationCount = 0
		let triggerAtMs = 0
		let latencyMs = Number.POSITIVE_INFINITY

		const notified = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('Timed out waiting for reactive notification')), 2000)

			const unsubscribe = query.subscribe(() => {
				notificationCount += 1
				if (notificationCount === 1) {
					return
				}

				latencyMs = performance.now() - triggerAtMs
				clearTimeout(timeout)
				unsubscribe()
				resolve()
			})
		})

		await sleep(10)
		triggerAtMs = performance.now()
		await todos.insert({ title: 'reactive-latency', completed: true })
		await notified

		expect(latencyMs).toBeLessThan(REACTIVE_NOTIFY_LIMIT_MS)
	}, 30_000)
})

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
