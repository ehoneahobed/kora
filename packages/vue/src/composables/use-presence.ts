import type { AwarenessState } from '@korajs/sync'
import { subscribeRemoteAwarenessStates } from '@korajs/sync'
import {
	type MaybeRefOrGetter,
	type ShallowRef,
	onScopeDispose,
	shallowRef,
	toValue,
	watch,
	watchEffect,
} from 'vue'
import { useKoraContextRef } from '../context'

/**
 * Sets the local user's collaborative presence state. `user` may be a ref, a getter or a
 * reactive object: a change updates what collaborators see, and null clears it.
 */
export function usePresence(
	user: MaybeRefOrGetter<{ name: string; color: string; avatar?: string } | null>,
): void {
	const context = useKoraContextRef()

	watch(
		() => {
			const current = toValue(user)
			return [context.value.syncEngine, current?.name, current?.color, current?.avatar] as const
		},
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
