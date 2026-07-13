import type { CollectionAccessor } from '@korajs/store'
import { getKoraContext } from '../context'

export function getCollection(name: string): CollectionAccessor {
	const { store } = getKoraContext()
	return store.collection(name)
}

/** Alias for {@link getCollection}. */
export const useCollection = getCollection
