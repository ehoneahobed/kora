import type { AwarenessState } from '@korajs/sync'
import { subscribeRemoteAwarenessStates } from '@korajs/sync'
import { type ShallowRef, onScopeDispose, shallowRef, watch, watchEffect } from 'vue'
import { useKoraContextRef } from '../context'

/**
 * Sets the local user's collaborative presence state.
 */
export function usePresence(user: { name: string; color: string; avatar?: string } | null): void {
	const context = useKoraContextRef()

	watch(
		() => [context.value.syncEngine, user?.name, user?.color, user?.avatar] as const,
		([engine, name, color, avatar], _prev, onCleanup) => {
			if (!engine || !name || !color) return

			const awareness = engine.getAwarenessManager()
			awareness.setLocalState({
				user: {
					name,
					color,
					avatar,
				},
			})

			onCleanup(() => {
				awareness.setLocalState(null)
			})
		},
		{ immediate: true },
	)
}

/**
 * Reactive list of remote collaborators' awareness states.
 */
export function useCollaborators(): ShallowRef<AwarenessState[]> {
	const context = useKoraContextRef()
	const collaborators = shallowRef<AwarenessState[]>([])

	watchEffect((onCleanup) => {
		const syncEngine = context.value.syncEngine
		if (!syncEngine) {
			collaborators.value = []
			return
		}

		const awareness = syncEngine.getAwarenessManager()
		const unsubscribe = subscribeRemoteAwarenessStates(awareness, (states) => {
			collaborators.value = states
		})
		onCleanup(unsubscribe)
	})

	onScopeDispose(() => {
		collaborators.value = []
	})

	return collaborators
}
