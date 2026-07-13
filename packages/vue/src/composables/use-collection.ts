import type { CollectionAccessor } from '@korajs/store'
import { useKoraContext } from '../context'

/**
 * Returns a collection accessor for the given schema collection name.
 */
export function useCollection(name: string): CollectionAccessor {
	const { store } = useKoraContext()
	return store.collection(name)
}
