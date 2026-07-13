import { OFFLINE_SYNC_STATUS, createSyncStatusController } from '@korajs/sync'
import type { SyncStatusInfo } from '@korajs/sync'
import { readable, type Readable } from 'svelte/store'
import { getKoraContext } from '../context'

/**
 * Readable store of sync engine status.
 */
export function createSyncStatusStore(): Readable<SyncStatusInfo> {
	const { syncEngine, subscribeSyncStatus, events } = getKoraContext()

	return readable<SyncStatusInfo>(OFFLINE_SYNC_STATUS, (set) => {
		const controller = createSyncStatusController({
			syncEngine,
			subscribeSyncStatus,
			events: subscribeSyncStatus ? null : events,
		})
		set(controller.getSnapshot())
		const unsubscribe = controller.subscribe(() => {
			set(controller.getSnapshot())
		})
		return () => {
			unsubscribe()
			controller.destroy()
		}
	})
}

/** Alias for {@link createSyncStatusStore}. */
export const useSyncStatus = createSyncStatusStore
