import type { CollectionRecord, QueryBuilder } from '@korajs/store'
import { useMemo } from 'react'
import { useKoraContext } from '../context/kora-context'
import type { KoraAppLike } from '../types'
import { useApp } from './use-app'
import { useMutation } from './use-mutation'
import { useQuery, useQueryState } from './use-query'
import { useSyncStatus } from './use-sync-status'

/**
 * The collections an app exposes, read from its `collections` namespace. Purely
 * structural, so it follows whatever accessor types `createApp` infers from the schema.
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

/**
 * Hooks bound to one app type, returned by {@link createKoraHooks}.
 */
export interface KoraHooks<TApp> {
	/** The app from the nearest `<KoraProvider app={app}>`, typed as `TApp`. */
	useApp: () => TApp
	/**
	 * The typed accessor of one collection: `insert`, `update` and `where` are checked
	 * against the schema. The accessor keeps its identity across renders.
	 */
	useCollection: <N extends AppCollectionName<TApp>>(name: N) => AppCollections<TApp>[N]
	/** {@link useQuery}: rows are typed from the query builder. */
	useQuery: typeof useQuery
	/** {@link useQueryState}: rows are typed from the query builder. */
	useQueryState: typeof useQueryState
	/** {@link useMutation}. */
	useMutation: typeof useMutation
	/** {@link useSyncStatus}. */
	useSyncStatus: typeof useSyncStatus
}

/**
 * Creates React hooks typed for one app, so components get schema-checked
 * collection names, inserts, updates and rows without passing generics around.
 * Call it once next to `createApp` and import the hooks from there. Nothing runs at
 * call time; the hooks read the app from `<KoraProvider app={app}>`.
 *
 * @returns {@link KoraHooks} for `TApp`
 *
 * @example
 * ```typescript
 * // kora.ts
 * export const app = createApp({ schema })
 * export const { useCollection, useQuery, useMutation } = createKoraHooks<typeof app>()
 *
 * // TodoList.tsx
 * const todos = useCollection('todos')          // 'todoz' is a type error
 * const rows = useQuery(todos.where({ completed: false }))
 * const { mutate: add } = useMutation(todos.insert)
 * ```
 */
export function createKoraHooks<TApp extends KoraAppLike>(): KoraHooks<TApp> {
	function useTypedApp(): TApp {
		return useApp<TApp>()
	}

	function useTypedCollection<N extends AppCollectionName<TApp>>(name: N): AppCollections<TApp>[N] {
		const { app, store } = useKoraContext()
		return useMemo(() => {
			const collections = (app as { collections?: Record<string, unknown> } | null)?.collections
			// The app's `collections` getters build a fresh accessor on every read: read once
			// per (app, name) so the accessor and the functions on it stay stable.
			const accessor: unknown =
				collections && name in collections ? collections[name] : store.collection(name)
			return accessor as AppCollections<TApp>[N]
		}, [app, store, name])
	}

	return {
		useApp: useTypedApp,
		useCollection: useTypedCollection,
		useQuery,
		useQueryState,
		useMutation,
		useSyncStatus,
	}
}
