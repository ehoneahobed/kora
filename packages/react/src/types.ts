import type { Store } from '@kora/store'
import type { SyncEngine } from '@kora/sync'

/**
 * Value provided by KoraProvider via React context.
 */
export interface KoraContextValue {
	/** The local Kora store instance */
	store: Store
	/** Optional sync engine for remote synchronization */
	syncEngine: SyncEngine | null
}

/**
 * Options for the useQuery hook.
 */
export interface UseQueryOptions {
	/** Set to false to disable the subscription (query won't execute). Defaults to true. */
	enabled?: boolean
}

/**
 * Result from the useMutation hook.
 */
export interface UseMutationResult<TData, TArgs extends unknown[]> {
	/** Fire-and-forget mutation. Catches errors silently (sets error state). */
	mutate: (...args: TArgs) => void
	/** Promise-returning mutation. Throws on error. */
	mutateAsync: (...args: TArgs) => Promise<TData>
	/** Whether a mutation is currently in progress */
	isLoading: boolean
	/** The last error that occurred, or null */
	error: Error | null
	/** Reset isLoading and error state */
	reset: () => void
}
