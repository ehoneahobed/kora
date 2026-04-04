import type { SchemaDefinition } from '@kora/core'
import type { MigrationPlan, StorageAdapter, Transaction } from '../types'

/**
 * IndexedDB adapter — fallback for browsers without OPFS/WASM support.
 * Not yet implemented — requires browser testing infrastructure.
 *
 * @throws Always throws "not yet implemented"
 */
export class IndexedDbAdapter implements StorageAdapter {
	async open(_schema: SchemaDefinition): Promise<void> {
		throw new Error('@kora/store IndexedDbAdapter is not yet implemented')
	}

	async close(): Promise<void> {
		throw new Error('@kora/store IndexedDbAdapter is not yet implemented')
	}

	async execute(_sql: string, _params?: unknown[]): Promise<void> {
		throw new Error('@kora/store IndexedDbAdapter is not yet implemented')
	}

	async query<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
		throw new Error('@kora/store IndexedDbAdapter is not yet implemented')
	}

	async transaction(_fn: (tx: Transaction) => Promise<void>): Promise<void> {
		throw new Error('@kora/store IndexedDbAdapter is not yet implemented')
	}

	async migrate(_from: number, _to: number, _migration: MigrationPlan): Promise<void> {
		throw new Error('@kora/store IndexedDbAdapter is not yet implemented')
	}
}
