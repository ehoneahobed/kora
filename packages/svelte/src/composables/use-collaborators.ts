import type { AwarenessState } from '@korajs/sync'
import { subscribeRemoteAwarenessStates } from '@korajs/sync'
import { readable, type Readable } from 'svelte/store'
import { getKoraContext } from '../context'

/**
 * Readable store of remote collaborators' awareness states.
 */
export function createCollaboratorsStore(): Readable<AwarenessState[]> {
	const { syncEngine } = getKoraContext()

	return readable<AwarenessState[]>([], (set) => {
		if (!syncEngine) {
			set([])
			return () => {}
		}

		const awareness = syncEngine.getAwarenessManager()
		return subscribeRemoteAwarenessStates(awareness, set)
	})
}

/** Alias for {@link createCollaboratorsStore}. */
export const useCollaborators = createCollaboratorsStore
