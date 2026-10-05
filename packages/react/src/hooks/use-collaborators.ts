import type { AwarenessState } from '@korajs/sync'
import { subscribeRemoteAwarenessStates } from '@korajs/sync'
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { useKoraContext } from '../context/kora-context'

const EMPTY_ARRAY: AwarenessState[] = []

// Server renders (and the hydration pass) have no peers: one shared empty list.
const getServerSnapshot = (): AwarenessState[] => EMPTY_ARRAY

/**
 * Returns all currently connected collaborators' awareness states.
 *
 * Excludes the local user — only returns remote peers. Safe under server rendering
 * (`renderToString`, Next.js App Router): the server and the hydration pass see `[]`.
 *
 * @returns The remote peers' awareness states; the same array until they change
 */
export function useCollaborators(): AwarenessState[] {
	const { syncEngine } = useKoraContext()

	const snapshotRef = useRef<AwarenessState[]>(EMPTY_ARRAY)

	const subscribe = useCallback(
		(onStoreChange: () => void): (() => void) => {
			if (!syncEngine) {
				snapshotRef.current = EMPTY_ARRAY
				return () => {}
			}

			const awareness = syncEngine.getAwarenessManager()
			// A fresh subscription starts from empty and emits the current peers at once, so a
			// resubscribe (StrictMode remount, engine swap) never keeps a stale list.
			snapshotRef.current = EMPTY_ARRAY
			return subscribeRemoteAwarenessStates(awareness, (states) => {
				snapshotRef.current = states
				onStoreChange()
			})
		},
		[syncEngine],
	)

	const getSnapshot = useCallback((): AwarenessState[] => snapshotRef.current, [])

	useEffect(() => {
		if (!syncEngine) {
			snapshotRef.current = EMPTY_ARRAY
		}
	}, [syncEngine])

	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
