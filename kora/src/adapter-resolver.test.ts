import { afterEach, describe, expect, test } from 'vitest'
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

describe('tauri-sqlite', () => {
	const key = Symbol.for('korajs.storage.tauri-sqlite')
	const registry = globalThis as unknown as Record<symbol, unknown>
	afterEach(() => {
		delete registry[key]
	})

	test('uses the adapter @korajs/tauri registered when the app imported it', async () => {
		class RegisteredAdapter {
			constructor(readonly options: { path: string }) {}
		}
		registry[key] = RegisteredAdapter
		const adapter = await createAdapter('tauri-sqlite', 'notes')
		expect(adapter).toBeInstanceOf(RegisteredAdapter)
		expect((adapter as unknown as RegisteredAdapter).options).toEqual({ path: 'notes.db' })
	})

	test('without @korajs/tauri, the error says what to add', async () => {
		await expect(createAdapter('tauri-sqlite', 'notes')).rejects.toThrow("import '@korajs/tauri'")
	})
})
