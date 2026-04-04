import { useCallback, useEffect, useRef, useState } from 'react'
import type { UseMutationResult } from '../types'

/**
 * React hook for performing mutations against the local Kora store.
 *
 * Returns `mutate` for fire-and-forget usage (optimistic) and `mutateAsync`
 * for when you need to await the result. Tracks loading and error state.
 *
 * @param mutationFn - An async function to execute (e.g., `app.todos.insert`)
 * @returns Object with mutate, mutateAsync, isLoading, error, and reset
 *
 * @example
 * ```typescript
 * const { mutate } = useMutation(app.todos.insert)
 * mutate({ title: 'New todo' }) // fire-and-forget
 * ```
 */
export function useMutation<TData, TArgs extends unknown[]>(
	mutationFn: (...args: TArgs) => Promise<TData>,
): UseMutationResult<TData, TArgs> {
	const [state, setState] = useState<{ isLoading: boolean; error: Error | null }>({
		isLoading: false,
		error: null,
	})

	// Track mounted state to avoid state updates after unmount
	const mountedRef = useRef(true)
	useEffect(() => {
		mountedRef.current = true
		return () => {
			mountedRef.current = false
		}
	}, [])

	// Keep latest mutation function in a ref to avoid stale closures
	const fnRef = useRef(mutationFn)
	fnRef.current = mutationFn

	const mutateAsync = useCallback(async (...args: TArgs): Promise<TData> => {
		if (mountedRef.current) {
			setState({ isLoading: true, error: null })
		}
		try {
			const result = await fnRef.current(...args)
			if (mountedRef.current) {
				setState({ isLoading: false, error: null })
			}
			return result
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			if (mountedRef.current) {
				setState({ isLoading: false, error })
			}
			throw error
		}
	}, [])

	const mutate = useCallback(
		(...args: TArgs): void => {
			mutateAsync(...args).catch(() => {
				// Fire-and-forget: error is captured in state, no unhandled rejection
			})
		},
		[mutateAsync],
	)

	const reset = useCallback((): void => {
		if (mountedRef.current) {
			setState({ isLoading: false, error: null })
		}
	}, [])

	return {
		mutate,
		mutateAsync,
		isLoading: state.isLoading,
		error: state.error,
		reset,
	}
}
