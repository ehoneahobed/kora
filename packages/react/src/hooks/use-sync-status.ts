import type { SyncStatusInfo } from '@kora/sync'
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { useKoraContext } from '../context/kora-context'

const POLL_INTERVAL_MS = 500

/** Default status returned when no sync engine is configured */
const OFFLINE_STATUS: SyncStatusInfo = Object.freeze({
	status: 'offline',
	pendingOperations: 0,
	lastSyncedAt: null,
})

/**
 * React hook for monitoring the sync engine's connection status.
 *
 * Polls the SyncEngine at ~500ms intervals and re-renders only when
 * the status actually changes. Returns a default offline status when
 * no sync engine is configured.
 *
 * @returns Current sync status information
 *
 * @example
 * ```typescript
 * const status = useSyncStatus()
 * // status.status: 'connected' | 'syncing' | 'synced' | 'offline' | 'error'
 * // status.pendingOperations: number
 * // status.lastSyncedAt: number | null
 * ```
 */
export function useSyncStatus(): SyncStatusInfo {
	const { syncEngine } = useKoraContext()

	// Cache the latest status snapshot for stable references
	const snapshotRef = useRef<SyncStatusInfo>(OFFLINE_STATUS)
	const serializedRef = useRef<string>(JSON.stringify(OFFLINE_STATUS))

	const subscribe = useCallback(
		(onStoreChange: () => void): (() => void) => {
			if (!syncEngine) return () => {}

			// Poll the sync engine status at regular intervals
			const intervalId = setInterval(() => {
				const newStatus = syncEngine.getStatus()
				const newSerialized = JSON.stringify(newStatus)

				// Only notify React if status actually changed
				if (newSerialized !== serializedRef.current) {
					snapshotRef.current = newStatus
					serializedRef.current = newSerialized
					onStoreChange()
				}
			}, POLL_INTERVAL_MS)

			// Do an immediate check
			const initialStatus = syncEngine.getStatus()
			const initialSerialized = JSON.stringify(initialStatus)
			if (initialSerialized !== serializedRef.current) {
				snapshotRef.current = initialStatus
				serializedRef.current = initialSerialized
				onStoreChange()
			}

			return () => {
				clearInterval(intervalId)
			}
		},
		[syncEngine],
	)

	const getSnapshot = useCallback((): SyncStatusInfo => {
		return snapshotRef.current
	}, [])

	// Reset snapshot when syncEngine changes
	useEffect(() => {
		if (!syncEngine) {
			snapshotRef.current = OFFLINE_STATUS
			serializedRef.current = JSON.stringify(OFFLINE_STATUS)
		}
	}, [syncEngine])

	return useSyncExternalStore(subscribe, getSnapshot)
}
