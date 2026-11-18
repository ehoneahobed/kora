import { KoraError } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { TauriDatabaseInUseError } from './database-files'
import { TauriAdapterError, TauriStoreNotOpenError } from './tauri-sqlite-adapter'

// AGENTS.md: every error a Kora package throws extends KoraError, so one `instanceof KoraError`
// check (and its `code` and `fix`) covers them all.
describe('Tauri errors are KoraErrors', () => {
	test('TauriAdapterError keeps its name, code and context', () => {
		const error = new TauriAdapterError('query failed', { sql: 'SELECT 1' })
		expect(error).toBeInstanceOf(KoraError)
		expect(error.name).toBe('TauriAdapterError')
		expect(error.code).toBe('TAURI_ADAPTER_ERROR')
		expect(error.context).toEqual({ sql: 'SELECT 1' })
	})

	test('TauriStoreNotOpenError keeps its name and code', () => {
		const error = new TauriStoreNotOpenError()
		expect(error).toBeInstanceOf(KoraError)
		expect(error.name).toBe('TauriStoreNotOpenError')
		expect(error.code).toBe('STORE_NOT_OPEN')
	})

	test('TauriDatabaseInUseError keeps its name and path, and has a code', () => {
		const error = new TauriDatabaseInUseError('kora-db.db')
		expect(error).toBeInstanceOf(KoraError)
		expect(error.name).toBe('TauriDatabaseInUseError')
		expect(error.path).toBe('kora-db.db')
		expect(error.code).toBe('TAURI_DATABASE_IN_USE')
	})
})
