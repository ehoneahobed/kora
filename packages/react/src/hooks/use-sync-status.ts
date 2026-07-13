import type { SyncStatusInfo } from '@korajs/sync'
import { createSyncStatusController } from '@korajs/sync'
import { useSyncExternalStore } from 'react'
import { useKoraContext } from '../context/kora-context'
import { useController } from './use-controller'

/**
 * React hook for monitoring the sync engine's connection status.
 */
export function useSyncStatus(): SyncStatusInfo {
	const { syncEngine, subscribeSyncStatus, events } = useKoraContext()

	const getController = useController(
		() =>
			createSyncStatusController({
				syncEngine,
				subscribeSyncStatus,
				events: subscribeSyncStatus ? null : events,
			}),
		(controller) => controller.destroy(),
		[syncEngine, subscribeSyncStatus, events],
	)

	return useSyncExternalStore(
		(onStoreChange) => getController().subscribe(onStoreChange),
		() => getController().getSnapshot(),
		() => getController().getSnapshot(),
	)
}
