import type { StorageAdapter } from '@korajs/store'
import type { AdapterType } from './types'

/**
 * Detect the best storage adapter for the current environment.
 *
 * - Tauri app: 'tauri-sqlite' (native SQLite via Tauri plugin)
 * - Node.js: 'better-sqlite3'
 * - Browser with OPFS: 'sqlite-wasm'
 * - Browser without OPFS: 'indexeddb'
 */
export function detectAdapterType(): AdapterType {
	// Tauri environment — detected via __TAURI_INTERNALS__ injected by the Tauri runtime
	if (
		typeof globalThis !== 'undefined' &&
		typeof (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined'
	) {
		return 'tauri-sqlite'
	}

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
export async function createAdapter(
	type: AdapterType,
	dbName: string,
	workerUrl?: string | URL,
): Promise<StorageAdapter> {
	switch (type) {
		case 'tauri-sqlite': {
			// Use Function-based import to prevent bundlers (Vite/Rollup/webpack)
			// from resolving @korajs/tauri at build time. This package is only
			// available in Tauri environments and must not be bundled for web.
			const dynamicImport = new Function('specifier', 'return import(specifier)') as (
				s: string,
			) => Promise<{ TauriSqliteAdapter: new (opts: { path: string }) => StorageAdapter }>
			const { TauriSqliteAdapter } = await dynamicImport('@korajs/tauri')
			return new TauriSqliteAdapter({ path: `${dbName}.db` })
		}
		case 'better-sqlite3': {
			const { BetterSqlite3Adapter } = await import(
				/* @vite-ignore */ '@korajs/store/better-sqlite3'
			)
			return new BetterSqlite3Adapter(dbName)
		}
		case 'sqlite-wasm': {
			const { SqliteWasmAdapter } = await import('@korajs/store/sqlite-wasm')
			return new SqliteWasmAdapter({ dbName, workerUrl })
		}
		case 'indexeddb': {
			const { IndexedDbAdapter } = await import('@korajs/store/indexeddb')
			return new IndexedDbAdapter({ dbName, workerUrl })
		}
		default: {
			const _exhaustive: never = type
			throw new Error(`Unknown adapter type: ${_exhaustive}`)
		}
	}
}
