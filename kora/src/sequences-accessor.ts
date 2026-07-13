import type { Store } from '@korajs/store'
import type { SequenceAccessor } from './types'

/**
 * Builds the offline-safe sequences accessor backed by the store sequence manager.
 */
export function createSequencesAccessor(
	ready: Promise<void>,
	getStore: () => Store | null,
): SequenceAccessor {
	const requireStore = async (): Promise<Store> => {
		await ready
		const store = getStore()
		if (!store) {
			throw new Error('Store not initialized. Await app.ready before using sequences.')
		}
		return store
	}

	return {
		async next(name, config) {
			const store = await requireStore()
			return store.getSequenceManager().next(name, config)
		},
		async current(name, config) {
			const store = await requireStore()
			return store.getSequenceManager().current(name, config)
		},
		async reset(name, config) {
			const store = await requireStore()
			return store.getSequenceManager().reset(name, config)
		},
	}
}
