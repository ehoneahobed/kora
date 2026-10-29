import {
	OFFLINE_STATUS_SERVER_RENDER,
	OFFLINE_STATUS_UNKNOWN,
	type OfflineStatus,
} from '@korajs/core/bindings'
import { useCallback, useSyncExternalStore } from 'react'
import { useKoraContext } from '../context/kora-context'

const getServerSnapshot = (): OfflineStatus => OFFLINE_STATUS_SERVER_RENDER

/**
 * Whether reloading this app with no network would open it with the data it was told to
 * keep. Reads `app.offline.status()`, a synchronous local snapshot: it never touches the
 * network and re-renders only when the status changes (the object keeps its identity
 * while unchanged). `state` is `ready`, `preparing` or `not-ready`; `reasons` says why not.
 *
 * Render on the server reports `not-ready` with `server-rendering`, so a statically
 * rendered "available offline" badge never claims what no device holds.
 *
 * @returns The current {@link OfflineStatus}
 *
 * @example
 * ```tsx
 * const offline = useOfflineReady()
 * return <Badge>{offline.state === 'ready' ? 'Available offline' : 'Not ready for offline'}</Badge>
 * ```
 */
export function useOfflineReady(): OfflineStatus {
	const { app } = useKoraContext()
	const offline = app?.offline

	const subscribe = useCallback(
		(onStoreChange: () => void) => (offline ? offline.subscribe(onStoreChange) : () => {}),
		[offline],
	)
	const getSnapshot = useCallback(
		(): OfflineStatus => offline?.status() ?? OFFLINE_STATUS_UNKNOWN,
		[offline],
	)
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
