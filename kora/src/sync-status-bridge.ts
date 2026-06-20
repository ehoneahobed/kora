import type { KoraEventEmitter, KoraEventType } from '@korajs/core'
import type { SyncStatusInfo } from '@korajs/sync'

const OFFLINE_STATUS: SyncStatusInfo = Object.freeze({
	status: 'offline',
	pendingOperations: 0,
	lastSyncedAt: null,
	lastSuccessfulPush: null,
	lastSuccessfulPull: null,
	conflicts: 0,
})

/** Sync-related events that may change {@link SyncStatusInfo}. */
const SYNC_STATUS_EVENT_TYPES = [
	'sync:connected',
	'sync:disconnected',
	'sync:schema-mismatch',
	'sync:auth-failed',
	'sync:sent',
	'sync:received',
	'sync:acknowledged',
	'sync:apply-failed',
	'sync:diagnostics',
	'sync:initial-sync-progress',
] as const satisfies readonly KoraEventType[]

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
	let currentStatus: SyncStatusInfo = OFFLINE_STATUS
	const listeners = new Set<(status: SyncStatusInfo) => void>()

	const refresh = (): void => {
		const engine = getSyncEngine()
		const next = engine ? engine.getStatus() : OFFLINE_STATUS
		const prevSerialized = JSON.stringify(currentStatus)
		const nextSerialized = JSON.stringify(next)
		if (prevSerialized === nextSerialized) {
			return
		}
		currentStatus = next
		for (const listener of listeners) {
			listener(currentStatus)
		}
	}

	const unsubs: Array<() => void> = []
	for (const type of SYNC_STATUS_EVENT_TYPES) {
		unsubs.push(emitter.on(type, refresh))
	}

	const bridge: SyncStatusBridge = {
		get status() {
			return currentStatus
		},
		subscribe(listener: (status: SyncStatusInfo) => void): () => void {
			listeners.add(listener)
			listener(currentStatus)
			return () => {
				listeners.delete(listener)
			}
		},
		refresh,
		destroy(): void {
			for (const unsub of unsubs) {
				unsub()
			}
			unsubs.length = 0
			listeners.clear()
		},
	}

	refresh()

	return bridge
}
