import type { AwarenessState } from '@korajs/sync'
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { useKoraContext } from '../context/kora-context'

const EMPTY_ARRAY: AwarenessState[] = []

/**
 * Returns all currently connected collaborators' awareness states.
 *
 * Excludes the local user -- only returns remote peers.
 * Re-renders only when the set of collaborators or their states change.
 *
 * @returns Array of awareness states for all connected remote users
 *
 * @example
 * ```typescript
 * function CollaboratorList() {
 *   const collaborators = useCollaborators()
 *   return (
 *     <ul>
 *       {collaborators.map(c => (
 *         <li key={c.user.name} style={{ color: c.user.color }}>
 *           {c.user.name}
 *         </li>
 *       ))}
 *     </ul>
 *   )
 * }
 * ```
 */
export function useCollaborators(): AwarenessState[] {
	const { syncEngine } = useKoraContext()

	const snapshotRef = useRef<AwarenessState[]>(EMPTY_ARRAY)
	const serializedRef = useRef<string>('[]')

	const subscribe = useCallback(
		(onStoreChange: () => void): (() => void) => {
			if (!syncEngine) return () => {}

			const awareness = syncEngine.getAwarenessManager()
			const localClientId = awareness.clientId

			// Update snapshot from current awareness states
			const updateSnapshot = (): void => {
				const states = awareness.getStates()
				const remoteStates: AwarenessState[] = []

				for (const [clientId, state] of states) {
					if (clientId === localClientId) continue
					remoteStates.push(state)
				}

				const newSerialized = JSON.stringify(remoteStates)
				if (newSerialized !== serializedRef.current) {
					snapshotRef.current = remoteStates
					serializedRef.current = newSerialized
					onStoreChange()
				}
			}

			// Listen for awareness changes
			const unsubscribe = awareness.on('change', () => {
				updateSnapshot()
			})

			// Initial snapshot
			updateSnapshot()

			return unsubscribe
		},
		[syncEngine],
	)

	const getSnapshot = useCallback((): AwarenessState[] => {
		return snapshotRef.current
	}, [])

	// Reset when syncEngine changes
	useEffect(() => {
		if (!syncEngine) {
			snapshotRef.current = EMPTY_ARRAY
			serializedRef.current = '[]'
		}
	}, [syncEngine])

	return useSyncExternalStore(subscribe, getSnapshot)
}
