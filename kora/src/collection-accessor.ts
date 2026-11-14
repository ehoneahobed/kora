import { AppNotReadyError, preReadyWritesAllowed } from '@korajs/core/lite'
import type {
	CollectionAccessor,
	CollectionRecord,
	QueryBuilder,
	Store,
	WriteOptions,
} from '@korajs/store'
import { StoreReadOnlyError } from '@korajs/store/lite'
import { DeferredQueryBuilder, type DeferredQueryHost } from './deferred-query'
import type { PreReadyWriteQueue } from './pre-ready-writes'

/** What a collection accessor needs from its app. */
export interface CollectionAccessorHost extends DeferredQueryHost {
	/** The open store, or null until `app.ready` (and the writes queued before it) resolved. */
	getStore(): Store | null
	/** Where hook writes wait for the store. */
	queue: PreReadyWriteQueue
	/** Why the app is read-only (writes queued before `ready` are refused too), or null. */
	readOnlyReason?: () => string | null
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

	// A write is accepted before the store opens when a hook opened the scope for it, and also
	// while the queue drains or just finished: a mutation that awaited one write and now makes
	// the next one (`await a.insert(); await b.insert()`) is past its synchronous part, and
	// must not be refused halfway.
	const allowed = (): boolean => preReadyWritesAllowed() || host.queue.acceptsDirectWrites
	// A read-only app refuses a write at once, rather than queue it to fail when the store opens.
	const assertWritable = (): void => {
		const reason = host.readOnlyReason?.() ?? null
		if (reason !== null) throw new StoreReadOnlyError(reason)
	}

	return {
		async insert(data: Record<string, unknown>, options?: WriteOptions) {
			const store = host.getStore()
			if (store) return store.collection(collectionName).insert(data, options)
			if (!allowed()) throw notReady('insert into')
			assertWritable()
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
			if (!allowed()) throw notReady('insert into')
			assertWritable()
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
			if (!allowed()) throw notReady('update')
			assertWritable()
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
			if (!allowed()) throw notReady('delete from')
			assertWritable()
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
