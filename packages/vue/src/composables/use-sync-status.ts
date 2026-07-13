import { OFFLINE_SYNC_STATUS, createSyncStatusController } from '@korajs/sync'
import { onScopeDispose, readonly, shallowRef, watchEffect } from 'vue'
import { useKoraContext } from '../context'

/**
 * Reactive sync engine status. Updates only when status payload changes.
 */
export function useSyncStatus() {
	const { syncEngine, subscribeSyncStatus, events } = useKoraContext()
	const status = shallowRef(OFFLINE_SYNC_STATUS)

	watchEffect((onCleanup) => {
		const controller = createSyncStatusController({
			syncEngine,
			subscribeSyncStatus,
			events: subscribeSyncStatus ? null : events,
		})
		status.value = controller.getSnapshot()
		const unsubscribe = controller.subscribe(() => {
			status.value = controller.getSnapshot()
		})
		onCleanup(() => {
			unsubscribe()
			controller.destroy()
		})
	})

	return readonly(status)
}
