import type { KoraEventEmitter } from '@korajs/core'
import { createSyncStatusController, type SyncStatusInfo } from '@korajs/sync'

/**
 * Event-driven sync status snapshot for non-React consumers (`app.sync.status`).
 */
export interface SyncStatusBridge {
	readonly status: SyncStatusInfo
	subscribe(listener: (status: SyncStatusInfo) => void): () => void
	refresh(): void
	destroy(): void
}

/**
 * Subscribe to sync events and expose a reactive status snapshot.
 */
export function createSyncStatusBridge(
	emitter: KoraEventEmitter,
	getSyncEngine: () => { getStatus(): SyncStatusInfo } | null,
): SyncStatusBridge {
	const controller = createSyncStatusController({
		getSyncEngine,
		subscribeSyncStatus: null,
		events: emitter,
	})

	return {
		get status() {
			return controller.getSnapshot()
		},
		subscribe(listener: (status: SyncStatusInfo) => void): () => void {
			return controller.subscribe(() => {
				listener(controller.getSnapshot())
			})
		},
		refresh: () => controller.refresh(),
		destroy: () => controller.destroy(),
	}
}
