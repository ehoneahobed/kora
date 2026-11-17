import { describe, expect, test } from 'vitest'
import { TauriSqliteAdapter } from './index'

describe('importing @korajs/tauri', () => {
	test("registers the adapter for createApp's Tauri detection", () => {
		const registry = globalThis as unknown as Record<symbol, unknown>
		expect(registry[Symbol.for('korajs.storage.tauri-sqlite')]).toBe(TauriSqliteAdapter)
	})
})
