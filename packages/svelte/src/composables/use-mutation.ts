import { createMutationController } from '@korajs/core/bindings'
import type { UseMutationOptions, UseMutationResult } from '../types'

/**
 * Create a mutation controller with optimistic update hooks.
 */
export function createMutation<TData, TArgs extends unknown[], TContext = void>(
	mutationFn: (...args: TArgs) => Promise<TData>,
	options?: UseMutationOptions<TData, TArgs, TContext>,
): UseMutationResult<TData, TArgs> {
	const optionsRef = { current: options }
	optionsRef.current = options

	const fnRef = { current: mutationFn }
	fnRef.current = mutationFn

	const controller = createMutationController<TData, TArgs, TContext>({
		mutationFn: (...args) => fnRef.current(...args),
		resolveOptions: () => optionsRef.current,
	})

	const loadingListeners = new Set<(value: boolean) => void>()
	const errorListeners = new Set<(value: Error | null) => void>()

	controller.subscribe(() => {
		const snapshot = controller.getSnapshot()
		for (const listener of loadingListeners) {
			listener(snapshot.isLoading)
		}
		for (const listener of errorListeners) {
			listener(snapshot.error)
		}
	})

	return {
		mutate: (...args: TArgs) => controller.mutate(...args),
		mutateAsync: (...args: TArgs) => controller.mutateAsync(...args),
		subscribeLoading: (fn) => {
			loadingListeners.add(fn)
			fn(controller.getSnapshot().isLoading)
			return () => loadingListeners.delete(fn)
		},
		subscribeError: (fn) => {
			errorListeners.add(fn)
			fn(controller.getSnapshot().error)
			return () => errorListeners.delete(fn)
		},
		get loading() {
			return controller.getSnapshot().isLoading
		},
		get isLoading() {
			return controller.getSnapshot().isLoading
		},
		get error() {
			return controller.getSnapshot().error
		},
		reset: () => controller.reset(),
	}
}

/** Alias for {@link createMutation}. */
export const useMutation = createMutation
