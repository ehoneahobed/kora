import type { AwarenessState } from '@korajs/sync'
import { subscribeRemoteAwarenessStates } from '@korajs/sync'
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { useKoraContext } from '../context/kora-context'

const EMPTY_ARRAY: AwarenessState[] = []

/**
 * Returns all currently connected collaborators' awareness states.
 *
 * Excludes the local user — only returns remote peers.
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

	return useSyncExternalStore(subscribe, getSnapshot)
}
