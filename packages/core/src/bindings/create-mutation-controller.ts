import type { UseMutationOptions } from './types'

export interface MutationControllerState {
	isLoading: boolean
	error: Error | null
}

export interface MutationController<TData, TArgs extends unknown[], TContext = void> {
	getSnapshot(): MutationControllerState
	subscribe(listener: () => void): () => void
	mutate(...args: TArgs): void
	mutateAsync(...args: TArgs): Promise<TData>
	reset(): void
	destroy(): void
}

export interface CreateMutationControllerOptions<TData, TArgs extends unknown[], TContext = void> {
	mutationFn: (...args: TArgs) => Promise<TData>
	options?: UseMutationOptions<TData, TArgs, TContext>
	/** Reads latest options on each mutation (for framework hooks with ref-backed options). */
	resolveOptions?: () => UseMutationOptions<TData, TArgs, TContext> | undefined
	onStateChange?: (state: MutationControllerState) => void
}

/**
 * Framework-agnostic mutation runner with optimistic lifecycle hooks.
 */
export function createMutationController<TData, TArgs extends unknown[], TContext = void>(
	options: CreateMutationControllerOptions<TData, TArgs, TContext>,
): MutationController<TData, TArgs, TContext> {
	let snapshot: MutationControllerState = { isLoading: false, error: null }
	const listeners = new Set<() => void>()
	let disposed = false
	let inFlight = 0

	const notify = (): void => {
		for (const listener of listeners) {
			listener()
		}
		options.onStateChange?.(snapshot)
	}

	const setSnapshot = (next: MutationControllerState): void => {
		snapshot = next
		notify()
	}

	const getSnapshot = (): MutationControllerState => snapshot

	const subscribe = (listener: () => void): (() => void) => {
		listeners.add(listener)
		return () => {
			listeners.delete(listener)
		}
	}

	const reset = (): void => {
		if (disposed) return
		setSnapshot({ isLoading: false, error: null })
	}

	const mutateAsync = async (...args: TArgs): Promise<TData> => {
		if (disposed) {
			throw new Error('Mutation controller is destroyed')
		}

		const opts = options.resolveOptions?.() ?? options.options
		let context: TContext | undefined

		inFlight++
		setSnapshot({ isLoading: true, error: null })

		try {
			if (opts?.onMutate) {
				context = await opts.onMutate(...args)
			}

			const result = await options.mutationFn(...args)
			inFlight = Math.max(0, inFlight - 1)
			setSnapshot({ isLoading: inFlight > 0, error: null })
			opts?.onSuccess?.(result, ...args)
			opts?.onSettled?.(result, null, ...args)
			return result
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))

			if (context !== undefined && opts?.onRollback) {
				await opts.onRollback(context, ...args)
			}

			inFlight = Math.max(0, inFlight - 1)
			setSnapshot({ isLoading: inFlight > 0, error })
			opts?.onError?.(error, ...args)
			opts?.onSettled?.(undefined, error, ...args)
			throw error
		}
	}

	const mutate = (...args: TArgs): void => {
		void mutateAsync(...args).catch(() => {})
	}

	const destroy = (): void => {
		disposed = true
		listeners.clear()
	}

	return {
		getSnapshot,
		subscribe,
		mutate,
		mutateAsync,
		reset,
		destroy,
	}
}
