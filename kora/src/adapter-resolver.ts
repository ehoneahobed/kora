import type { StorageAdapter } from '@kora/store'
import type { AdapterType } from './types'

/**
 * Detect the best storage adapter for the current environment.
 *
 * - Node.js: 'better-sqlite3'
 * - Browser with OPFS: 'sqlite-wasm'
 * - Browser without OPFS: 'indexeddb'
 */
export function detectAdapterType(): AdapterType {
	// Node.js environment
	if (typeof process !== 'undefined' && process.versions?.node) {
		return 'better-sqlite3'
	}

	// Browser environment
	if (typeof globalThis.navigator !== 'undefined') {
		// Check for OPFS support (FileSystemHandle indicates OPFS availability)
		if (typeof (globalThis as Record<string, unknown>).FileSystemHandle !== 'undefined') {
			return 'sqlite-wasm'
		}
		return 'indexeddb'
	}

	// Default fallback (e.g., Deno, Bun, or other runtimes)
	return 'better-sqlite3'
}

/**
 * Create a StorageAdapter for the given adapter type.
 * Uses dynamic imports so unused adapters are not bundled.
 *
 * @param type - The adapter type to create
 * @param dbName - Database name (used by all adapters)
 * @returns A configured StorageAdapter instance
 */
export async function createAdapter(type: AdapterType, dbName: string): Promise<StorageAdapter> {
	switch (type) {
		case 'better-sqlite3': {
			const { BetterSqlite3Adapter } = await import('@kora/store/better-sqlite3')
			return new BetterSqlite3Adapter(dbName)
		}
		case 'sqlite-wasm': {
			const { SqliteWasmAdapter } = await import('@kora/store/sqlite-wasm')
			return new SqliteWasmAdapter({ dbName })
		}
		case 'indexeddb': {
			const { IndexedDbAdapter } = await import('@kora/store/indexeddb')
			return new IndexedDbAdapter({ dbName })
		}
		default: {
			const _exhaustive: never = type
			throw new Error(`Unknown adapter type: ${_exhaustive}`)
		}
	}
}
