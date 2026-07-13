import { getKoraContext } from '../context'

/**
 * Applies local collaborative presence. Returns a cleanup function.
 *
 * In Svelte components, call from an effect:
 * `$effect(() => applyPresence(user))`
 */
export function applyPresence(
	user: { name: string; color: string; avatar?: string } | null,
): () => void {
	const { syncEngine } = getKoraContext()
	if (!syncEngine || !user?.name || !user?.color) {
		return () => {}
	}

	const awareness = syncEngine.getAwarenessManager()
	awareness.setLocalState({
		user: {
			name: user.name,
			color: user.color,
			avatar: user.avatar,
		},
	})

	return () => {
		awareness.setLocalState(null)
	}
}

/** Alias for {@link applyPresence} — use inside `$effect()` in `.svelte` files. */
export const usePresence = applyPresence
