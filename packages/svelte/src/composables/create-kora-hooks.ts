import type { CollectionRecord, QueryBuilder } from '@korajs/store'
import { getKoraContext } from '../context'
import { useQuery, useQueryState } from '../stores/query-store'
import type { KoraAppLike } from '../types'
import { getApp } from './use-app'
import { useMutation } from './use-mutation'
import { useSyncStatus } from './use-sync-status'
import { useSyncSummary } from './use-sync-summary'

/**
 * The collections an app exposes, read from its `collections` namespace. Purely structural,
 * so it follows whatever accessor types `createApp` infers from the schema.
 */
export type AppCollections<TApp> = TApp extends { collections: infer C } ? C : never

/** The collection names of an app, as string literals. */
export type AppCollectionName<TApp> = Extract<keyof AppCollections<TApp>, string>

/** The record type of a collection accessor, inferred from what its queries return. */
export type AccessorRecord<TAccessor> = TAccessor extends {
	where(...args: never[]): QueryBuilder<infer R>
}
	? R
	: CollectionRecord

/** The record type of collection `N` of an app. */
export type AppRecord<TApp, N extends AppCollectionName<TApp>> = AccessorRecord<
	AppCollections<TApp>[N]
>

/** The app's own accessor for `name` when it has one, else the store's. */
function accessorOf(
	app: unknown,
	store: { collection(name: string): unknown },
	name: string,
): unknown {
	const collections = (app as { collections?: Record<string, unknown> } | null)?.collections
	// The app's `collections` getters build an accessor per read: read it once here.
	return collections && name in collections ? collections[name] : store.collection(name)
}

/** Helpers bound to one app type, returned by {@link createKoraHooks}. */
export interface KoraHooks<TApp> {
	/** The app from the nearest `<KoraProvider app={app}>`, typed as `TApp`. */
	useApp: () => TApp
	/** Alias for {@link KoraHooks.useApp}. */
	getApp: () => TApp
	/** The typed accessor of one collection: `insert`, `update` and `where` follow the schema. */
	useCollection: <N extends AppCollectionName<TApp>>(name: N) => AppCollections<TApp>[N]
	/** Alias for {@link KoraHooks.useCollection}. */
	getCollection: <N extends AppCollectionName<TApp>>(name: N) => AppCollections<TApp>[N]
	/** {@link useQuery}: rows are typed from the query builder. */
	useQuery: typeof useQuery
	/** {@link useQueryState}: rows are typed from the query builder. */
	useQueryState: typeof useQueryState
	/** {@link useMutation}. */
	useMutation: typeof useMutation
	/** {@link useSyncStatus}. */
	useSyncStatus: typeof useSyncStatus
	/** {@link useSyncSummary}. */
	useSyncSummary: typeof useSyncSummary
}

/**
 * Creates Svelte helpers typed for one app, so components get schema-checked collection names,
 * inserts, updates and rows without passing generics around. Call it once next to `createApp`
 * and import the helpers from there. Nothing runs at call time; they read the app from
 * `<KoraProvider app={app}>` (call them during component initialization).
 *
 * @returns {@link KoraHooks} for `TApp`
 *
 * @example
 * ```typescript
 * // kora.ts
 * export const app = createApp({ schema })
 * export const { useCollection, useQuery, useMutation } = createKoraHooks<typeof app>()
 *
 * // TodoList.svelte (script)
 * const todos = useCollection('todos') // 'todoz' is a type error
 * const rows = useQuery(todos.where({ completed: false }))
 * ```
 */
export function createKoraHooks<TApp extends KoraAppLike>(): KoraHooks<TApp> {
	const typedApp = (): TApp => getApp<TApp>()
	const typedCollection = <N extends AppCollectionName<TApp>>(name: N): AppCollections<TApp>[N] => {
		const { app, store } = getKoraContext()
		return accessorOf(app, store, name) as AppCollections<TApp>[N]
	}
	return {
		useApp: typedApp,
		getApp: typedApp,
		useCollection: typedCollection,
		getCollection: typedCollection,
		useQuery,
		useQueryState,
		useMutation,
		useSyncStatus,
		useSyncSummary,
	}
}
