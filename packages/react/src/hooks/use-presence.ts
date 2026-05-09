import type { AwarenessState } from '@korajs/sync'
import { useEffect } from 'react'
import { useKoraContext } from '../context/kora-context'

/**
 * Sets the local user's collaborative presence state.
 *
 * When this hook is active, other connected clients will see this user's
 * presence information (name, color, optional cursor position).
 *
 * Automatically cleans up presence on unmount.
 *
 * @param user - User identity for presence display. Pass null to clear.
 *
 * @example
 * ```typescript
 * function Editor() {
 *   usePresence({ name: 'Alice', color: '#e91e63' })
 *   return <div>...</div>
 * }
 * ```
 */
export function usePresence(user: { name: string; color: string; avatar?: string } | null): void {
	const { syncEngine } = useKoraContext()
	const name = user?.name ?? null
	const color = user?.color ?? null
	const avatar = user?.avatar ?? null

	useEffect(() => {
		if (!syncEngine || !name || !color) return

		const awareness = syncEngine.getAwarenessManager()

		const state: AwarenessState = {
			user: { name, color, avatar: avatar ?? undefined },
		}
		awareness.setLocalState(state)

		return () => {
			// Clear presence on unmount
			awareness.setLocalState(null)
		}
	}, [syncEngine, name, color, avatar])
}
