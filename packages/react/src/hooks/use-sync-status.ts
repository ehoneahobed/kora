import type { KoraEventType } from '@korajs/core'
import type { SyncStatusInfo } from '@korajs/sync'
import { useCallback, useRef, useSyncExternalStore } from 'react'
import { useKoraContext } from '../context/kora-context'

const OFFLINE_STATUS: SyncStatusInfo = Object.freeze({
	status: 'offline',
	pendingOperations: 0,
	lastSyncedAt: null,
	lastSuccessfulPush: null,
	lastSuccessfulPull: null,
	conflicts: 0,
})

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
 * React hook for monitoring the sync engine's connection status.
 *
 * Subscribes to sync events via `app.sync.subscribeStatus` (or the sync engine
 * emitter when using store-only mode) and re-renders only when status changes.
 *
 * @returns Current sync status information
 *
 * @example
 * ```typescript
 * const status = useSyncStatus()
 * // status.status: 'connected' | 'syncing' | 'synced' | 'offline' | 'error'
 * ```
 */
export function useSyncStatus(): SyncStatusInfo {
	const { syncEngine, subscribeSyncStatus, events } = useKoraContext()
	const snapshotRef = useRef<SyncStatusInfo>(OFFLINE_STATUS)
	const serializedRef = useRef<string>(JSON.stringify(OFFLINE_STATUS))

	const subscribe = useCallback(
		(onStoreChange: () => void): (() => void) => {
			if (subscribeSyncStatus) {
				return subscribeSyncStatus((status) => {
					snapshotRef.current = status
					serializedRef.current = JSON.stringify(status)
					onStoreChange()
				})
			}

			if (!syncEngine) {
				return () => {}
			}

			const refresh = (): void => {
				const newStatus = syncEngine.getStatus()
				const newSerialized = JSON.stringify(newStatus)
				if (newSerialized !== serializedRef.current) {
					snapshotRef.current = newStatus
					serializedRef.current = newSerialized
					onStoreChange()
				}
			}

			if (events) {
				const unsubs = SYNC_STATUS_EVENT_TYPES.map((type) => events.on(type, refresh))
				refresh()
				return () => {
					for (const unsub of unsubs) {
						unsub()
					}
				}
			}

			refresh()
			return () => {}
		},
		[syncEngine, subscribeSyncStatus, events],
	)

	const getSnapshot = useCallback((): SyncStatusInfo => {
		if (subscribeSyncStatus) {
			return snapshotRef.current
		}
		return syncEngine ? syncEngine.getStatus() : OFFLINE_STATUS
	}, [syncEngine, subscribeSyncStatus])

	return useSyncExternalStore(subscribe, getSnapshot)
}
