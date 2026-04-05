import type { CollectionAccessor } from '@korajs/store'
import { useMemo } from 'react'
import { useKoraContext } from '../context/kora-context'

/**
 * React hook that returns a CollectionAccessor for the given collection name.
 * Convenience hook for accessing a collection without going through the store directly.
 *
 * @param name - The collection name (must match a collection in the schema)
 * @returns CollectionAccessor with insert, findById, update, delete, and where methods
 *
 * @example
 * ```typescript
 * const todos = useCollection('todos')
 * await todos.insert({ title: 'New todo' })
 * ```
 */
export function useCollection(name: string): CollectionAccessor {
	const { store } = useKoraContext()

	return useMemo(() => {
		return store.collection(name)
	}, [store, name])
}
