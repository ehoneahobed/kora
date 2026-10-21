import { createMutationController } from '@korajs/core/bindings'
import { inject, onScopeDispose, ref, shallowReadonly, shallowRef } from 'vue'
import { koraContextKey } from '../context'
import type { MutationRejection, UseMutationOptions, UseMutationResult } from '../types'

/**
 * Mutation composable with optional optimistic update and rollback hooks.
 *
 * Inside `<KoraProvider :app="app">`, each call's operations are remembered until the
 * server stores them: a permanent server refusal, even hours later, sets `rejected` and
 * calls `onRejected` while the owning component is mounted.
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
	const rejected = shallowRef<MutationRejection<TArgs> | null>(null)
	let mounted = true
	// Optional: without a provider the composable still works, without rejection tracking.
	const events = inject(koraContextKey, null)?.value?.events ?? null

	onScopeDispose(() => {
		mounted = false
	})

	const controller = createMutationController<TData, TArgs, TContext>({
		mutationFn: (...args) => fnRef.current(...args),
		resolveOptions: () => optionsRef.current,
		events,
		onStateChange: (state) => {
			if (!mounted) return
			isLoading.value = state.isLoading
			error.value = state.error
			rejected.value = state.rejected as MutationRejection<TArgs> | null
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
		rejected: shallowReadonly(rejected),
		reset: () => controller.reset(),
	}
}
