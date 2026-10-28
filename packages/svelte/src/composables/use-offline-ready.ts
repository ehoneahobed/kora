import { OFFLINE_STATUS_UNKNOWN, type OfflineStatus } from '@korajs/core/bindings'
import { type Readable, readable } from 'svelte/store'
import { getKoraContext } from '../context'

/**
 * Readable store of offline readiness: whether reloading with no network would open the app
 * with the data it was told to keep. Backed by `app.offline`; updates only when the status
 * changes and never touches the network.
 */
export function createOfflineReadyStore(): Readable<OfflineStatus> {
	const { app } = getKoraContext()
	const offline = app?.offline

	return readable<OfflineStatus>(offline?.status() ?? OFFLINE_STATUS_UNKNOWN, (set) => {
		if (!offline) return undefined
		set(offline.status())
		return offline.subscribe((next) => set(next))
	})
}

/** Alias for {@link createOfflineReadyStore}. */
export const useOfflineReady = createOfflineReadyStore
