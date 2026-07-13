import { AppNotReadyError } from '@korajs/core'
import type { CollectionAccessor, QueryBuilder, Store } from '@korajs/store'

/**
 * Builds a collection accessor that throws {@link AppNotReadyError} until the store opens.
 */
export function createCollectionAccessor(
	collectionName: string,
	getStore: () => Store | null,
): CollectionAccessor {
	const notReady = (action: string): AppNotReadyError =>
		new AppNotReadyError(
			`Cannot ${action} on collection "${collectionName}" before app.ready. Await app.ready or use <KoraProvider app={app}>.`,
		)

	return {
		async insert(data: Record<string, unknown>) {
			const currentStore = getStore()
			if (!currentStore) {
				throw notReady('insert into')
			}
			return currentStore.collection(collectionName).insert(data)
		},
		async findById(id: string) {
			const currentStore = getStore()
			if (!currentStore) return null
			return currentStore.collection(collectionName).findById(id)
		},
		async update(id: string, data: Record<string, unknown>) {
			const currentStore = getStore()
			if (!currentStore) {
				throw notReady('update')
			}
			return currentStore.collection(collectionName).update(id, data)
		},
		async delete(id: string) {
			const currentStore = getStore()
			if (!currentStore) {
				throw notReady('delete from')
			}
			return currentStore.collection(collectionName).delete(id)
		},
		where(conditions: Record<string, unknown>): QueryBuilder {
			const currentStore = getStore()
			if (!currentStore) {
				throw notReady('query')
			}
			return currentStore.collection(collectionName).where(conditions)
		},
	}
}
