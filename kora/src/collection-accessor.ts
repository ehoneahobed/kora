import { AppNotReadyError, preReadyWritesAllowed } from '@korajs/core/lite'
import type {
	CollectionAccessor,
	CollectionRecord,
	QueryBuilder,
	Store,
	WriteOptions,
} from '@korajs/store'
import { DeferredQueryBuilder, type DeferredQueryHost } from './deferred-query'
import type { PreReadyWriteQueue } from './pre-ready-writes'

/** What a collection accessor needs from its app. */
export interface CollectionAccessorHost extends DeferredQueryHost {
	/** The open store, or null until `app.ready` (and the writes queued before it) resolved. */
	getStore(): Store | null
	/** Where hook writes wait for the store. */
	queue: PreReadyWriteQueue
}

/**
 * Builds a collection accessor that works before and after the store opens.
 *
 * After `app.ready` every method goes straight to the store. Before it:
 *
 * - `where()` returns a deferred query (same fluent API; it runs when the store opens), so
 *   `useQuery(app.todos.where(...))` can run during the first render.
 * - `insert`, `insertMany`, `update` and `delete` called through a framework hook
 *   (`useMutation`) are queued, saved to the write journal and applied when the store
 *   opens. The same call made directly still throws {@link AppNotReadyError}: nothing
 *   would store it and the caller would not know.
 * - `findById` throws {@link AppNotReadyError}: a `null` would read as "no such record".
 *
 * @param collectionName - A collection of the schema
 * @param host - The app pieces the accessor reads
 * @returns The accessor behind `app.<collection>` and `app.collections.<collection>`
 */
export function createCollectionAccessor(
	collectionName: string,
	host: CollectionAccessorHost,
): CollectionAccessor {
	const notReady = (action: string): AppNotReadyError =>
		new AppNotReadyError(
			`Cannot ${action} on collection "${collectionName}" before app.ready. Await app.ready, use <KoraProvider app={app}>, or make the write through useMutation, which waits for the store.`,
		)

	return {
		async insert(data: Record<string, unknown>, options?: WriteOptions) {
			const store = host.getStore()
			if (store) return store.collection(collectionName).insert(data, options)
			if (!preReadyWritesAllowed()) throw notReady('insert into')
			return (await host.queue.enqueue(
				collectionName,
				'insert',
				[data],
				options,
			)) as CollectionRecord
		},
		async insertMany(rows: readonly Record<string, unknown>[], options?: WriteOptions) {
			const store = host.getStore()
			if (store) return store.collection(collectionName).insertMany(rows, options)
			if (!preReadyWritesAllowed()) throw notReady('insert into')
			return (await host.queue.enqueue(
				collectionName,
				'insertMany',
				[rows],
				options,
			)) as CollectionRecord[]
		},
		async findById(id: string) {
			const store = host.getStore()
			// A null here would be indistinguishable from "no such record" (DX-4).
			if (!store) throw notReady('find a record in')
			return store.collection(collectionName).findById(id)
		},
		async update(id: string, data: Record<string, unknown>, options?: WriteOptions) {
			const store = host.getStore()
			if (store) return store.collection(collectionName).update(id, data, options)
			if (!preReadyWritesAllowed()) throw notReady('update')
			return (await host.queue.enqueue(
				collectionName,
				'update',
				[id, data],
				options,
			)) as CollectionRecord
		},
		async delete(id: string, options?: WriteOptions) {
			const store = host.getStore()
			if (store) return store.collection(collectionName).delete(id, options)
			if (!preReadyWritesAllowed()) throw notReady('delete from')
			await host.queue.enqueue(collectionName, 'delete', [id], options)
		},
		where(conditions: Record<string, unknown>): QueryBuilder {
			const store = host.getStore()
			if (store) return store.collection(collectionName).where(conditions)
			// Not a real QueryBuilder, but it reports the same descriptor and runs on the real one
			// as soon as the store is open.
			return new DeferredQueryBuilder(collectionName, host, conditions) as unknown as QueryBuilder
		},
	}
}
