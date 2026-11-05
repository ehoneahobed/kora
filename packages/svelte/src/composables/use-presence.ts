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
	const context = getKoraContext()
	if (!user?.name || !user?.color) {
		return () => {}
	}
	const { name, color, avatar } = user

	let clear = (): void => {}
	let cancelled = false
	const apply = (): void => {
		const engine = context.syncEngine
		if (cancelled || !engine) return
		const awareness = engine.getAwarenessManager()
		awareness.setLocalState({ user: { name, color, avatar } })
		clear = () => awareness.setLocalState(null)
	}
	if (context.syncEngine) {
		apply()
	} else if (context.app) {
		// The provider renders before the store opens: present once the engine exists.
		context.app.ready.then(apply, () => {})
	}

	return () => {
		cancelled = true
		clear()
	}
}

/** Alias for {@link applyPresence} — use inside `$effect()` in `.svelte` files. */
export const usePresence = applyPresence
