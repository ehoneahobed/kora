import type { CollectionRecord, QueryBuilder, Store } from '@korajs/store'
import { QueryStoreCache } from '@korajs/store'
import type { SyncEngine, SyncStatusInfo } from '@korajs/sync'
import { vi } from 'vitest'
import type { KoraAppLike } from '../../src/types'

/** A query builder whose results the test pushes by hand. */
export interface FakeQuery {
	query: QueryBuilder
	emit(rows: CollectionRecord[]): void
	fail(error: Error): void
	subscribeCount(): number
}

export const row = (id: string, title = id): CollectionRecord =>
	({ id, title, createdAt: 1, updatedAt: 1 }) as CollectionRecord

/**
 * Builds a {@link FakeQuery}. `initial` is delivered synchronously on subscribe, like
 * the store's registerAndFetch does once its first read resolves.
 */
export function createFakeQuery(key: string, initial: CollectionRecord[] | null = []): FakeQuery {
	let callback: ((rows: CollectionRecord[]) => void) | null = null
	let onError: ((error: Error) => void) | null = null
	let subscribes = 0
	const query = {
		getDescriptor: () => ({ collection: 'todos', where: { key }, orderBy: [] }),
		subscribe: (cb: (rows: CollectionRecord[]) => void, errorCb?: (error: Error) => void) => {
			subscribes++
			callback = cb
			onError = errorCb ?? null
			if (initial) cb(initial)
			return () => {
				callback = null
				onError = null
			}
		},
	} as unknown as QueryBuilder
	return {
		query,
		emit: (rows) => callback?.(rows),
		fail: (error) => onError?.(error),
		subscribeCount: () => subscribes,
	}
}

/** A minimal Store: hooks here only need it as an identity. */
export function createFakeStore(): Store {
	return { collection: vi.fn(() => ({ where: vi.fn() })) } as unknown as Store
}

/** A minimal app whose query cache and sync bridge the test controls. */
export function createFakeApp(options: {
	store?: Store
	queryStoreCache?: QueryStoreCache
	syncEngine?: SyncEngine | null
	subscribeStatus?: (listener: (status: SyncStatusInfo) => void) => () => void
	collections?: Record<string, unknown>
}): KoraAppLike & { collections?: Record<string, unknown> } {
	const store = options.store ?? createFakeStore()
	const cache = options.queryStoreCache ?? new QueryStoreCache()
	return {
		ready: Promise.resolve(),
		getStore: () => store,
		getSyncEngine: () => options.syncEngine ?? null,
		getQueryStoreCache: () => cache,
		sync: options.subscribeStatus ? { subscribeStatus: options.subscribeStatus } : null,
		...(options.collections ? { collections: options.collections } : {}),
	} as KoraAppLike & { collections?: Record<string, unknown> }
}
