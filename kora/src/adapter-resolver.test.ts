import { describe, expect, test } from 'vitest'
import { createAdapter, detectAdapterType } from './adapter-resolver'

describe('detectAdapterType', () => {
	test('detects better-sqlite3 in Node.js environment', () => {
		// We are running in Node.js (via Vitest), so this should return better-sqlite3
		expect(detectAdapterType()).toBe('better-sqlite3')
	})
})

describe('createAdapter', () => {
	test('creates a BetterSqlite3Adapter for better-sqlite3 type', async () => {
		const adapter = await createAdapter('better-sqlite3', ':memory:')
		expect(adapter).toBeDefined()
		expect(typeof adapter.open).toBe('function')
		expect(typeof adapter.close).toBe('function')
		expect(typeof adapter.execute).toBe('function')
		expect(typeof adapter.query).toBe('function')
		expect(typeof adapter.transaction).toBe('function')
	})

	test('throws for unknown adapter type', async () => {
		await expect(createAdapter('unknown' as 'better-sqlite3', ':memory:')).rejects.toThrow(
			'Unknown adapter type',
		)
	})
})
