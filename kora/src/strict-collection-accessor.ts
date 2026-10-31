import { AppNotReadyError } from '@korajs/core'
import type { CollectionAccessor, QueryBuilder, Store, WriteOptions } from '@korajs/store'

/**
 * Builds a collection accessor that throws {@link AppNotReadyError} until the store opens.
 */
export function createStrictCollectionAccessor(
	collectionName: string,
	getStore: () => Store | null,
): CollectionAccessor {
	const notReady = (action: string): AppNotReadyError =>
		new AppNotReadyError(
			`Cannot ${action} on collection "${collectionName}" before app.ready. Await app.ready or use <KoraProvider app={app}>.`,
		)

	return {
		async insert(data: Record<string, unknown>, options?: WriteOptions) {
			const currentStore = getStore()
			if (!currentStore) {
				throw notReady('insert into')
			}
			return currentStore.collection(collectionName).insert(data, options)
		},
		async insertMany(rows: readonly Record<string, unknown>[], options?: WriteOptions) {
			const currentStore = getStore()
			if (!currentStore) {
				throw notReady('insert into')
			}
			return currentStore.collection(collectionName).insertMany(rows, options)
		},
		async findById(id: string) {
			const currentStore = getStore()
			// A null here would be indistinguishable from "no such record" (DX-4).
			if (!currentStore) {
				throw notReady('find a record in')
			}
			return currentStore.collection(collectionName).findById(id)
		},
		async update(id: string, data: Record<string, unknown>, options?: WriteOptions) {
			const currentStore = getStore()
			if (!currentStore) {
				throw notReady('update')
			}
			return currentStore.collection(collectionName).update(id, data, options)
		},
		async delete(id: string, options?: WriteOptions) {
			const currentStore = getStore()
			if (!currentStore) {
				throw notReady('delete from')
			}
			return currentStore.collection(collectionName).delete(id, options)
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
