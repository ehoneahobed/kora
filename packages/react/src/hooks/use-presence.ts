import { useEffect } from 'react'
import { useKoraContext } from '../context/kora-context'

/**
 * Sets the local user's collaborative presence state.
 *
 * Automatically cleans up presence on unmount.
 */
export function usePresence(user: { name: string; color: string; avatar?: string } | null): void {
	const { syncEngine } = useKoraContext()
	const name = user?.name ?? null
	const color = user?.color ?? null
	const avatar = user?.avatar ?? null

	useEffect(() => {
		if (!syncEngine || !name || !color) return

		const awareness = syncEngine.getAwarenessManager()
		awareness.setLocalState({
			user: { name, color, avatar: avatar ?? undefined },
		})

		return () => {
			awareness.setLocalState(null)
		}
	}, [syncEngine, name, color, avatar])
}
