import { createMutationController } from '@korajs/core/bindings'
import { useRef, useSyncExternalStore } from 'react'
import type { UseMutationOptions, UseMutationResult } from '../types'
import { useController } from './use-controller'

/**
 * React hook for performing mutations against the local Kora store.
 */
export function useMutation<TData, TArgs extends unknown[], TContext = void>(
	mutationFn: (...args: TArgs) => Promise<TData>,
	options?: UseMutationOptions<TData, TArgs, TContext>,
): UseMutationResult<TData, TArgs> {
	const fnRef = useRef(mutationFn)
	fnRef.current = mutationFn

	const optionsRef = useRef(options)
	optionsRef.current = options

	const getController = useController(
		() =>
			createMutationController<TData, TArgs, TContext>({
				mutationFn: (...args) => fnRef.current(...args),
				resolveOptions: () => optionsRef.current,
			}),
		(controller) => controller.destroy(),
		[],
	)

	const state = useSyncExternalStore(
		(onStoreChange) => getController().subscribe(onStoreChange),
		() => getController().getSnapshot(),
		() => getController().getSnapshot(),
	)

	return {
		mutate: (...args: TArgs) => getController().mutate(...args),
		mutateAsync: (...args: TArgs) => getController().mutateAsync(...args),
		isLoading: state.isLoading,
		error: state.error,
		reset: () => getController().reset(),
	}
}
