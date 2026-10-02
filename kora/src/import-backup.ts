import type { RestoreOptions, RestoreResult, Store } from '@korajs/store'
import type { ApplyPipeline } from './apply-pipeline'
import type { SyncRuntimeState } from './sync-lifecycle'
import type { KoraConfig } from './types'

/**
 * `app.importBackup()` (STORE-5): restore through the store with the app's own
 * remote-apply path (the merge-aware pipeline sync uses), keeping this device's identity.
 *
 * - Merge mode applies the backup's operations exactly like operations received from
 *   sync, while sync keeps running.
 * - Replace mode pauses sync for the restore and resumes it afterwards, so the engine
 *   reloads the reset delivery watermarks and re-downloads everything in scope. With sync
 *   configured, this device's unsynced writes are always kept (they may sit in the
 *   outbound queue and exist nowhere else); a local-only app gets an exact replace by
 *   default.
 */
export async function importBackupIntoApp(
	store: Store,
	pipeline: ApplyPipeline | null,
	config: KoraConfig,
	state: SyncRuntimeState,
	data: Uint8Array,
	options?: RestoreOptions,
): Promise<RestoreResult> {
	const synced = config.sync !== undefined
	if (synced && options?.keepUnsyncedWrites === false && !options.merge) {
		return {
			operationsRestored: 0,
			recordsRestored: 0,
			success: false,
			error:
				'keepUnsyncedWrites: false is not supported while sync is configured: those writes may already be queued for upload. Discard them explicitly instead (app.sync.discardHeld for held writes).',
			errorCode: 'BACKUP_KEEP_UNSYNCED_REQUIRED',
			duration: 0,
		}
	}
	const restoreOptions: RestoreOptions = {
		...options,
		keepUnsyncedWrites: options?.keepUnsyncedWrites ?? synced,
	}
	const internal = pipeline
		? {
				applyOperation: (operation: Parameters<ApplyPipeline['applyRemote']>[0]) =>
					pipeline.applyRemote(operation),
			}
		: undefined

	const engine = state.syncEngine
	if (options?.merge || !engine) {
		return store.importBackup(data, restoreOptions, internal)
	}

	const wasIntentional = state.intentionalDisconnect
	state.intentionalDisconnect = true
	state.reconnectionManager?.stop()
	await engine.stop()
	try {
		return await store.importBackup(data, restoreOptions, internal)
	} finally {
		state.intentionalDisconnect = wasIntentional
		if (!wasIntentional) {
			// Resume like the initial start: a failure surfaces as sync:disconnected, which
			// hands over to the reconnection manager.
			state.reconnectionManager?.reset()
			await engine.start().catch(() => undefined)
		}
		state.syncStatusBridge?.refresh()
	}
}
