import type { KoraEventEmitter } from '@korajs/core'
import type { StorageAdapter } from '@korajs/store'
import type { AdapterType } from './types'

/** Dynamic import that bundlers cannot statically analyze (optional peer packages). */
function importOptionalPeer<T>(specifier: string): Promise<T> {
	const dynamicImport = new Function('specifier', 'return import(specifier)') as (
		s: string,
	) => Promise<T>
	return dynamicImport(specifier)
}

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
	emitter?: KoraEventEmitter,
	workerResponseTimeoutMs?: number,
	sharedWorkerUrl?: string | URL,
): Promise<StorageAdapter> {
	switch (type) {
		case 'tauri-sqlite': {
			// @korajs/tauri is only installed in Tauri projects (optional peer dep).
			// Runtime import via Function so Vite/Rollup do not pre-bundle or resolve the module.
			const { TauriSqliteAdapter } = await importOptionalPeer<{
				TauriSqliteAdapter: new (options: { path: string }) => StorageAdapter
			}>('@korajs/tauri')
			return new TauriSqliteAdapter({ path: `${dbName}.db` })
		}
		case 'better-sqlite3': {
			// Node-only adapter. The specifier is assembled at runtime so bundlers
			// cannot statically follow this import into a browser graph. A literal
			// `await import('@korajs/store/better-sqlite3')` (even with @vite-ignore)
			// is a static code-split point that Rollup/Vite resolve and include, which
			// is what pulled better-sqlite3 and its native bindings into browser builds
			// and forced apps to add a manual alias/shim to exclude it. Unlike the
			// `new Function` trick used for optional peers, this stays a real import()
			// so it still resolves under Node and test runners.
			const specifier = ['@korajs/store', 'better-sqlite3'].join('/')
			const { BetterSqlite3Adapter } = (await import(/* @vite-ignore */ specifier)) as {
				BetterSqlite3Adapter: new (dbName: string) => StorageAdapter
			}
			return new BetterSqlite3Adapter(dbName)
		}
		case 'sqlite-wasm': {
			const { SqliteWasmAdapter } = await import('@korajs/store/sqlite-wasm')
			return new SqliteWasmAdapter({ dbName, workerUrl, sharedWorkerUrl, workerResponseTimeoutMs })
		}
		case 'indexeddb': {
			const { IndexedDbAdapter } = await import('@korajs/store/indexeddb')
			return new IndexedDbAdapter({ dbName, workerUrl, emitter, workerResponseTimeoutMs })
		}
		default: {
			const _exhaustive: never = type
			throw new Error(`Unknown adapter type: ${_exhaustive}`)
		}
	}
}
