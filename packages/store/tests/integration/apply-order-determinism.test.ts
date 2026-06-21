import { HybridLogicalClock, createOperation, generateUUIDv7 } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { topologicalSort } from '@korajs/core/internal'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { Store } from '../../src/store/store'
import { minimalSchema } from '../fixtures/test-schema'

const clockA = new HybridLogicalClock('node-a')
const clockB = new HybridLogicalClock('node-b')

async function makeInsert(
	clock: HybridLogicalClock,
	nodeId: string,
	seq: number,
	title: string,
): Promise<Operation> {
	return createOperation(
		{
			nodeId,
			type: 'insert',
			collection: 'todos',
			recordId: generateUUIDv7(),
			data: { title, completed: false },
			previousData: null,
			sequenceNumber: seq,
			causalDeps: [],
			schemaVersion: 1,
		},
		clock,
	)
}

async function materializeTitles(store: Store): Promise<string[]> {
	const rows = await store.collection('todos').where({}).exec()
	return rows.map((row) => String(row.title)).sort()
}

describe('apply order determinism', () => {
	let store: Store

	beforeEach(async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		store = new Store({ schema: minimalSchema, adapter, nodeId: 'determinism-node' })
		await store.open()
	})

	afterEach(async () => {
		await store.close()
	})

	test('100 random apply orderings converge to identical materialized state', async () => {
		const insertA = await makeInsert(clockA, 'node-a', 1, 'Alpha')
		const insertB = await makeInsert(clockB, 'node-b', 1, 'Beta')
		const ops = topologicalSort([insertA, insertB])

		for (const op of ops) {
			await store.applyRemoteOperation(op)
		}
		const expected = await materializeTitles(store)
		await store.close()

		for (let trial = 0; trial < 100; trial++) {
			const adapter = new BetterSqlite3Adapter(':memory:')
			const trialStore = new Store({ schema: minimalSchema, adapter, nodeId: 'determinism-node' })
			await trialStore.open()

			const shuffled = shuffleWithSeed([...ops], trial + 1)
			for (const op of shuffled) {
				await trialStore.applyRemoteOperation(op)
			}

			const titles = await materializeTitles(trialStore)
			expect(titles).toEqual(expected)
			await trialStore.close()
		}
	})
})

function shuffleWithSeed<T>(items: T[], seed: number): T[] {
	const result = [...items]
	let state = seed
	for (let i = result.length - 1; i > 0; i--) {
		state = (state * 1103515245 + 12345) & 0x7fffffff
		const j = state % (i + 1)
		const tmp = result[i] as T
		result[i] = result[j] as T
		result[j] = tmp
	}
	return result
}
