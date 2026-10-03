import { createMutationController } from '@korajs/core/bindings'
import type { MutationControllerState } from '@korajs/core/bindings'
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import type { UseMutationOptions, UseMutationResult } from '../types'
import { useController } from './use-controller'

// What a server render (and the hydration pass) shows: nothing is running.
const IDLE: MutationControllerState = Object.freeze({ isLoading: false, error: null })
const getServerSnapshot = (): MutationControllerState => IDLE

/**
 * React hook for performing mutations against the local Kora store.
 *
 * `mutate`, `mutateAsync` and `reset` keep their identity for the component's lifetime
 * (safe in effect deps and as memoized props), and the result object only changes when
 * `isLoading` or `error` does. The latest `mutationFn` and `options` are always used.
 *
 * @param mutationFn - The mutation to run, for example `app.todos.insert`
 * @param options - Optional lifecycle callbacks (`onMutate`, `onSuccess`, `onError`, `onSettled`)
 * @returns `{ mutate, mutateAsync, isLoading, error, reset }`
 *
 * @example
 * ```tsx
 * const { mutate: addTodo, isLoading } = useMutation(app.todos.insert)
 * return <button disabled={isLoading} onClick={() => addTodo({ title: 'New' })}>Add</button>
 * ```
 */
export function useMutation<TData, TArgs extends unknown[], TContext = void>(
	mutationFn: (...args: TArgs) => Promise<TData>,
	options?: UseMutationOptions<TData, TArgs, TContext>,
): UseMutationResult<TData, TArgs> {
	const fnRef = useRef(mutationFn)
	fnRef.current = mutationFn

	const optionsRef = useRef(options)
	optionsRef.current = options

	const controller = useController(
		() =>
			createMutationController<TData, TArgs, TContext>({
				mutationFn: (...args) => fnRef.current(...args),
				resolveOptions: () => optionsRef.current,
			}),
		(instance) => instance.destroy(),
		[],
	)
	const getController = controller.get

	// biome-ignore lint/correctness/useExhaustiveDependencies: version re-keys subscribe when the controller is replaced
	const subscribe = useCallback(
		(onStoreChange: () => void) => getController().subscribe(onStoreChange),
		[getController, controller.version],
	)
	const getSnapshot = useCallback(() => getController().getSnapshot(), [getController])

	const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

	const mutate = useCallback((...args: TArgs) => getController().mutate(...args), [getController])
	const mutateAsync = useCallback(
		(...args: TArgs) => getController().mutateAsync(...args),
		[getController],
	)
	const reset = useCallback(() => getController().reset(), [getController])

	return useMemo(
		() => ({ mutate, mutateAsync, isLoading: state.isLoading, error: state.error, reset }),
		[mutate, mutateAsync, reset, state.isLoading, state.error],
	)
}
