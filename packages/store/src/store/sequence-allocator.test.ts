import { describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { allocateNextSequenceInTransaction, readSequenceNumber } from './sequence-allocator'

describe('sequence-allocator', () => {
	test('allocateNextSequenceInTransaction increments per node inside the transaction', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		await adapter.open(minimalSchema)

		let a = 0
		let b = 0
		let c = 0
		await adapter.transaction(async (tx) => {
			a = await allocateNextSequenceInTransaction(tx, 'node-a')
			b = await allocateNextSequenceInTransaction(tx, 'node-a')
			c = await allocateNextSequenceInTransaction(tx, 'node-b')
		})

		expect(a).toBe(1)
		expect(b).toBe(2)
		expect(c).toBe(1)
		expect(await readSequenceNumber(adapter, 'node-a')).toBe(2)

		await adapter.close()
	})

	test('a rolled-back transaction gives its numbers back', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		await adapter.open(minimalSchema)
		await adapter
			.transaction(async (tx) => {
				await allocateNextSequenceInTransaction(tx, 'node-a')
				throw new Error('rollback')
			})
			.catch(() => {})
		expect(await readSequenceNumber(adapter, 'node-a')).toBe(0)
		await adapter.close()
	})
})
