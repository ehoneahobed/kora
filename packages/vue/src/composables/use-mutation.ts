import { createMutationController } from '@korajs/core/bindings'
import { onScopeDispose, ref, shallowReadonly } from 'vue'
import type { UseMutationOptions, UseMutationResult } from '../types'

/**
 * Mutation composable with optional optimistic update and rollback hooks.
 */
export function useMutation<TData, TArgs extends unknown[], TContext = void>(
	mutationFn: (...args: TArgs) => Promise<TData>,
	options?: UseMutationOptions<TData, TArgs, TContext>,
): UseMutationResult<TData, TArgs> {
	const fnRef = { current: mutationFn }
	fnRef.current = mutationFn

	const optionsRef = { current: options }
	optionsRef.current = options

	const isLoading = ref(false)
	const error = ref<Error | null>(null)
	let mounted = true

	onScopeDispose(() => {
		mounted = false
	})

	const controller = createMutationController<TData, TArgs, TContext>({
		mutationFn: (...args) => fnRef.current(...args),
		resolveOptions: () => optionsRef.current,
		onStateChange: (state) => {
			if (!mounted) return
			isLoading.value = state.isLoading
			error.value = state.error
		},
	})

	isLoading.value = controller.getSnapshot().isLoading
	error.value = controller.getSnapshot().error

	onScopeDispose(() => {
		controller.destroy()
	})

	return {
		mutate: (...args: TArgs) => controller.mutate(...args),
		mutateAsync: (...args: TArgs) => controller.mutateAsync(...args),
		isLoading: shallowReadonly(isLoading),
		error: shallowReadonly(error),
		reset: () => controller.reset(),
	}
}
