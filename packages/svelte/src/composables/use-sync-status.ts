import type { SyncStatusInfo } from '@korajs/sync'
import { OFFLINE_SYNC_STATUS, createSyncStatusController } from '@korajs/sync/lite'
import { type Readable, readable } from 'svelte/store'
import { getKoraContext } from '../context'

/**
 * Readable store of sync engine status.
 */
export function createSyncStatusStore(): Readable<SyncStatusInfo> {
	const context = getKoraContext()

	return readable<SyncStatusInfo>(OFFLINE_SYNC_STATUS, (set) => {
		let stop = (): void => {}
		const attach = (): void => {
			stop()
			// Read here, not above: the engine arrives when the store opens.
			const { syncEngine, subscribeSyncStatus, events } = context
			const controller = createSyncStatusController({
				syncEngine,
				subscribeSyncStatus,
				events: subscribeSyncStatus ? null : events,
			})
			set(controller.getSnapshot())
			const unsubscribe = controller.subscribe(() => {
				set(controller.getSnapshot())
			})
			stop = () => {
				unsubscribe()
				controller.destroy()
			}
		}
		attach()
		let cancelled = false
		// The provider renders before the store opens: follow the engine when it exists.
		if (!context.syncEngine && context.app) {
			context.app.ready.then(
				() => {
					if (!cancelled) attach()
				},
				() => {},
			)
		}
		return () => {
			cancelled = true
			stop()
		}
	})
}

/** Alias for {@link createSyncStatusStore}. */
export const useSyncStatus = createSyncStatusStore
