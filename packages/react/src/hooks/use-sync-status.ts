import type { SyncStatusInfo } from '@korajs/sync'
import { OFFLINE_SYNC_STATUS, createSyncStatusController } from '@korajs/sync'
import { useCallback, useSyncExternalStore } from 'react'
import { useKoraContext } from '../context/kora-context'
import { useController } from './use-controller'

const getServerSnapshot = (): SyncStatusInfo => OFFLINE_SYNC_STATUS

/**
 * React hook for monitoring the sync engine's connection status.
 *
 * Re-renders only when the status payload changes. The returned object, and its nested
 * `heldNodes`, `initialSync` and `blockedFailure` values, keep their identity while
 * unchanged, so they are safe as effect or memo dependencies. Beyond `status` and
 * `pendingOperations` it reports `heldOperations` / `heldNodes` (writes of another
 * user waiting on this device), `localDurability` (`'degraded'` when the local
 * database cannot persist) and `serverProtocolVersion` / `protocolDeprecated`.
 *
 * @returns The current {@link SyncStatusInfo}
 *
 * @example
 * ```tsx
 * const { status, pendingOperations, localDurability } = useSyncStatus()
 * ```
 */
export function useSyncStatus(): SyncStatusInfo {
	const { syncEngine, subscribeSyncStatus, events } = useKoraContext()

	const controller = useController(
		() =>
			createSyncStatusController({
				syncEngine,
				subscribeSyncStatus,
				events: subscribeSyncStatus ? null : events,
			}),
		(instance) => instance.destroy(),
		[syncEngine, subscribeSyncStatus, events],
	)
	const getController = controller.get

	// biome-ignore lint/correctness/useExhaustiveDependencies: version re-keys subscribe when the controller is replaced
	const subscribe = useCallback(
		(onStoreChange: () => void) => getController().subscribe(onStoreChange),
		[getController, controller.version],
	)
	// Creating the controller subscribes to the engine, so a render never creates one:
	// until the component commits (and always on the server) the status is offline.
	const peek = controller.peek
	const getSnapshot = useCallback(
		(): SyncStatusInfo => peek()?.getSnapshot() ?? OFFLINE_SYNC_STATUS,
		[peek],
	)

	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
