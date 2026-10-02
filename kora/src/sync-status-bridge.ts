import type { KoraEventEmitter } from '@korajs/core'
import { type SyncStatusInfo, createSyncStatusController } from '@korajs/sync'

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
	getSyncEngine: () => {
		getStatus(): SyncStatusInfo
		onStatusChange?(listener: () => void): () => void
	} | null,
): SyncStatusBridge {
	const controller = createSyncStatusController({
		getSyncEngine,
		subscribeSyncStatus: null,
		events: emitter,
	})
	// Some status changes have no event (an upload ack lowering the pending count, the
	// move to streaming). Without this, a waiter such as waitForSettled only saw them at
	// the next unrelated event, seconds later or never (RT-28).
	let unsubscribeEngine = getSyncEngine()?.onStatusChange?.(() => controller.refresh()) ?? null

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
		destroy: () => {
			unsubscribeEngine?.()
			unsubscribeEngine = null
			controller.destroy()
		},
	}
}
