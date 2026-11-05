import { OFFLINE_SYNC_STATUS, createSyncStatusController } from '@korajs/sync/lite'
import { onScopeDispose, readonly, shallowRef, watchEffect } from 'vue'
import { useKoraContextRef } from '../context'

/**
 * Reactive sync engine status. Updates only when status payload changes.
 */
export function useSyncStatus() {
	const context = useKoraContextRef()
	const status = shallowRef(OFFLINE_SYNC_STATUS)

	watchEffect((onCleanup) => {
		// Read inside the effect: the engine arrives when the store opens.
		const { syncEngine, subscribeSyncStatus, events } = context.value
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
