import { KoraError, type KoraEventEmitter, quoteIdent } from '@korajs/core'
import { StoragePersistence, type WriteDurabilityState } from '@korajs/store'
import { hasUnsyncedOwnOperations } from '@korajs/store/internal'
import type {
	AuthSyncBinding,
	KoraConfig,
	LocalDatabaseInfo,
	StorageApi,
	StorageEviction,
	StorageWritesApi,
} from './types'

/** Read access to a database, as handed to the unsynced-data check. */
interface DatabaseReader {
	query<T>(sql: string, params?: unknown[]): Promise<T[]>
}

/**
 * Whether a local database still holds operations the server never
 * acknowledged. With sync configured that is the persisted outbound queue
 * (`_kora_sync_queue`) plus, authoritatively, every own operation of any local node
 * id above that node's contiguous acknowledged prefix that the server did not refuse
 * for good (RT-41): such operations are often not queued (the one-time upgrade
 * re-upload, an operation committed just before the tab died, a closed per-tab tab).
 * A local-only app never syncs, so any recorded operation counts as unsynced and
 * deleting the database would lose it.
 */
export async function hasUnsyncedOperations(
	db: DatabaseReader,
	syncConfigured: boolean,
): Promise<boolean> {
	return (await countUnsyncedOperations(db, syncConfigured)) > 0
}

/**
 * How many operations only this device holds, as {@link hasUnsyncedOperations} judges it.
 * With sync it is the persisted outbound queue; when the queue is empty but own operations
 * above the acknowledged prefix remain, at least one is counted (the exact number would
 * need the prefix per node, and callers only need "how many, roughly"). A local-only app
 * never syncs: every recorded operation counts.
 */
export async function countUnsyncedOperations(
	db: DatabaseReader,
	syncConfigured: boolean,
): Promise<number> {
	const tables = await db.query<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table'",
	)
	const names = tables.map((table) => table.name)
	let queued = 0
	if (names.includes('_kora_sync_queue')) {
		const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM _kora_sync_queue')
		queued = rows[0]?.n ?? 0
	}
	if (syncConfigured) {
		if (queued > 0) return queued
		return (await hasUnsyncedOwnOperations(db)) ? 1 : 0
	}
	let total = queued
	for (const name of names) {
		if (!name.startsWith('_kora_ops_')) continue
		const rows = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`)
		total += rows[0]?.n ?? 0
	}
	return total
}

/**
 * `app.storage`: explicit management of the local databases on this origin.
 * Kora never deletes a database on its own; these calls are the only way, and
 * deletion refuses while the database is open or has unsynced operations.
 */
export function createStorageApi(
	config: KoraConfig,
	persistence: StoragePersistence = new StoragePersistence(),
	writes: StorageWritesApi = { status: () => ({ state: 'durable' }), subscribe: () => () => {} },
	getStore: () => { getStorageEviction(): StorageEviction | null } | null = () => null,
): StorageApi {
	return {
		writes,
		get evicted(): StorageEviction | null {
			return getStore()?.getStorageEviction() ?? null
		},
		persistence: {
			status: () => persistence.status(),
			request: () => persistence.request(),
		},
		async listDatabases(): Promise<LocalDatabaseInfo[]> {
			if (typeof indexedDB === 'undefined') return []
			const { listLocalDatabases } = await import('@korajs/store/sqlite-wasm')
			return listLocalDatabases()
		},
		async deleteDatabase(name: string, options: { force?: boolean } = {}): Promise<boolean> {
			const workerUrl = config.store?.workerUrl
			if (!workerUrl || typeof indexedDB === 'undefined') {
				throw new KoraError(
					'app.storage.deleteDatabase() manages browser storage and needs store.workerUrl. Server and Node stores are files you manage directly.',
					'STORAGE_UNSUPPORTED',
					{ name },
				)
			}
			const { deleteLocalDatabase } = await import('@korajs/store/sqlite-wasm')
			return deleteLocalDatabase(name, {
				workerUrl,
				force: options.force === true,
				workerResponseTimeoutMs: config.store?.workerResponseTimeoutMs,
				hasUnsyncedOperations: (db) => hasUnsyncedOperations(db, config.sync !== undefined),
			})
		},
	}
}

/** Whether the page runs as an installed app (PWA / home-screen web app). */
function runningAsInstalledApp(): boolean {
	const g = globalThis as {
		matchMedia?: (query: string) => { matches: boolean }
		navigator?: { standalone?: boolean }
	}
	try {
		if (g.navigator?.standalone === true) return true
		return g.matchMedia?.('(display-mode: standalone)').matches === true
	} catch {
		// matchMedia can throw in exotic embedders; not installed is the safe answer.
		return false
	}
}

/**
 * Start durable-storage tracking for an app after its store opened (NEW-STORE-4).
 * Nothing here is awaited by `app.ready`: the boot `persisted()` check never
 * prompts and runs in the background, and in `'auto'` mode `persist()` is
 * requested fire-and-forget after sign-in, the first local write, or at boot when
 * running as an installed app. Results arrive as `storage:persistence` events.
 *
 * @returns A cleanup function that removes the triggers
 */
export function wireStoragePersistence(
	config: KoraConfig,
	emitter: KoraEventEmitter,
	persistence: StoragePersistence,
	authBinding: AuthSyncBinding | null,
): () => void {
	void persistence.check()
	if (config.store?.persistence === 'manual') return () => {}

	const cleanups: Array<() => void> = []
	if (runningAsInstalledApp()) persistence.requestInBackground('installed-app')

	const offWrite = emitter.on('operation:created', () => {
		offWrite()
		persistence.requestInBackground('first-write')
	})
	cleanups.push(offWrite)

	if (authBinding?.subscribe && authBinding.resolveSyncState) {
		const resolveState = authBinding.resolveSyncState.bind(authBinding)
		let wasAuthenticated: boolean | null = null
		const observe = (): void => {
			resolveState().then(
				(state) => {
					const authenticated = state.state === 'authenticated'
					// Only a transition into a signed-in state counts as "after sign-in".
					if (authenticated && wasAuthenticated === false) {
						persistence.requestInBackground('sign-in')
					}
					wasAuthenticated = authenticated
				},
				() => {
					// Auth state unknown: no trigger; persistence is best-effort here.
				},
			)
		}
		observe()
		cleanups.push(authBinding.subscribe(observe))
	}

	return () => {
		for (const cleanup of cleanups) cleanup()
	}
}

/**
 * `app.storage.writes`: whether local writes are durable when their promise resolves.
 * The state lives in the store (opened after `createApp` returns), so the accessor reads
 * it lazily and re-emits the `store:write-durability` events.
 */
export function createStorageWritesApi(
	getStore: () => { getWriteDurability(): WriteDurabilityState } | null,
	emitter: KoraEventEmitter,
): StorageWritesApi {
	return {
		status: () => getStore()?.getWriteDurability() ?? { state: 'durable' },
		subscribe(callback) {
			return emitter.on('store:write-durability', () => callback())
		},
	}
}
