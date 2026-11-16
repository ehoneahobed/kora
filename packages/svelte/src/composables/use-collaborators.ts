import type { AwarenessState } from '@korajs/sync'
import { subscribeRemoteAwarenessStates } from '@korajs/sync'
import { type Readable, readable } from 'svelte/store'
import { getKoraContext } from '../context'

/**
 * Readable store of remote collaborators' awareness states.
 */
export function createCollaboratorsStore(): Readable<AwarenessState[]> {
	const context = getKoraContext()

	return readable<AwarenessState[]>([], (set) => {
		let stop = (): void => {}
		let cancelled = false
		const attach = (): void => {
			// Read here, not above: the engine arrives when the store opens.
			const syncEngine = context.syncEngine
			if (cancelled || !syncEngine) return
			stop = subscribeRemoteAwarenessStates(syncEngine.getAwarenessManager(), set)
		}
		set([])
		if (context.syncEngine) {
			attach()
		} else if (context.app) {
			// The provider renders before the store opens: follow the engine when it exists.
			context.app.ready.then(attach, () => {})
		}
		return () => {
			cancelled = true
			stop()
		}
	})
}

/** Alias for {@link createCollaboratorsStore}. */
export const useCollaborators = createCollaboratorsStore
