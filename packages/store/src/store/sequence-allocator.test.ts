import { describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { allocateNextSequenceNumber, readSequenceNumber } from './sequence-allocator'

describe('sequence-allocator', () => {
	test('allocateNextSequenceNumber increments atomically per node', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		await adapter.open(minimalSchema)

		const a = await allocateNextSequenceNumber(adapter, 'node-a')
		const b = await allocateNextSequenceNumber(adapter, 'node-a')
		const c = await allocateNextSequenceNumber(adapter, 'node-b')

		expect(a).toBe(1)
		expect(b).toBe(2)
		expect(c).toBe(1)
		expect(await readSequenceNumber(adapter, 'node-a')).toBe(2)

		await adapter.close()
	})
})
