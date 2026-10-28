import { OFFLINE_STATUS_UNKNOWN, type OfflineStatus } from '@korajs/core/bindings'
import { onScopeDispose, readonly, shallowRef } from 'vue'
import { useKoraContext } from '../context'

/**
 * Reactive offline readiness: whether reloading with no network would open the app with the
 * data it was told to keep. A readonly ref of `app.offline.status()`; it updates only when
 * the status changes and never touches the network.
 */
export function useOfflineReady() {
	const { app } = useKoraContext()
	const offline = app?.offline
	const status = shallowRef<OfflineStatus>(offline?.status() ?? OFFLINE_STATUS_UNKNOWN)
	if (offline) {
		const unsubscribe = offline.subscribe((next) => {
			status.value = next
		})
		onScopeDispose(unsubscribe)
	}
	return readonly(status)
}
