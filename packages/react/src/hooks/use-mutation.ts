import { useCallback, useEffect, useRef, useState } from 'react'
import type { UseMutationOptions, UseMutationResult } from '../types'

/**
 * React hook for performing mutations against the local Kora store.
 *
 * Returns `mutate` for fire-and-forget usage and `mutateAsync` when you need
 * to await the result. Optional `onMutate` / `onRollback` support optimistic
 * UI updates that revert if the mutation throws.
 *
 * @param mutationFn - An async function to execute (e.g., `app.todos.insert`)
 * @param options - Optional optimistic/rollback and lifecycle callbacks
 * @returns Object with mutate, mutateAsync, isLoading, error, and reset
 *
 * @example
 * ```typescript
 * const { mutate } = useMutation(app.todos.insert, {
 *   onMutate: (data) => {
 *     const previous = todos
 *     setTodos((list) => [...list, { id: 'temp', ...data }])
 *     return previous
 *   },
 *   onRollback: (previous) => setTodos(previous),
 * })
 * ```
 */
export function useMutation<TData, TArgs extends unknown[], TContext = void>(
	mutationFn: (...args: TArgs) => Promise<TData>,
	options?: UseMutationOptions<TData, TArgs, TContext>,
): UseMutationResult<TData, TArgs> {
	const [state, setState] = useState<{ isLoading: boolean; error: Error | null }>({
		isLoading: false,
		error: null,
	})

	const mountedRef = useRef(true)
	useEffect(() => {
		mountedRef.current = true
		return () => {
			mountedRef.current = false
		}
	}, [])

	const fnRef = useRef(mutationFn)
	fnRef.current = mutationFn

	const optionsRef = useRef(options)
	optionsRef.current = options

	const mutateAsync = useCallback(async (...args: TArgs): Promise<TData> => {
		const opts = optionsRef.current
		let context: TContext | undefined

		if (mountedRef.current) {
			setState({ isLoading: true, error: null })
		}

		try {
			if (opts?.onMutate) {
				context = await opts.onMutate(...args)
			}

			const result = await fnRef.current(...args)

			if (mountedRef.current) {
				setState({ isLoading: false, error: null })
			}
			opts?.onSuccess?.(result, ...args)
			opts?.onSettled?.(result, null, ...args)
			return result
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))

			if (context !== undefined && opts?.onRollback) {
				await opts.onRollback(context, ...args)
			}

			if (mountedRef.current) {
				setState({ isLoading: false, error })
			}
			opts?.onError?.(error, ...args)
			opts?.onSettled?.(undefined, error, ...args)
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
