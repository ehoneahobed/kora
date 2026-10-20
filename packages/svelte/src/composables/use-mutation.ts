import type { KoraEventEmitter } from '@korajs/core'
import { createMutationController } from '@korajs/core/bindings'
import { getContext, onDestroy } from 'svelte'
import type {
	KoraContextValue,
	MutationRejection,
	UseMutationOptions,
	UseMutationResult,
} from '../types'

// Same registered key as `context.ts` (read here without throwing when absent).
const koraContextKey = Symbol.for('@korajs/svelte:context')

/** The provider's event emitter, or null outside a component or a provider. */
function optionalEvents(): KoraEventEmitter | null {
	try {
		return getContext<KoraContextValue | undefined>(koraContextKey)?.events ?? null
	} catch {
		// Not inside component initialization (manual usage): no context to read.
		return null
	}
}

/**
 * Create a mutation controller with optimistic update hooks.
 *
 * Inside `<KoraProvider app={app}>`, each call's operations are remembered until the
 * server stores them: a permanent server refusal, even hours later, sets `rejected` and
 * calls `onRejected` until the owning component is destroyed.
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
		events: optionalEvents(),
	})

	const loadingListeners = new Set<(value: boolean) => void>()
	const errorListeners = new Set<(value: Error | null) => void>()
	const rejectedListeners = new Set<(value: MutationRejection<TArgs> | null) => void>()
	const currentRejected = (): MutationRejection<TArgs> | null =>
		controller.getSnapshot().rejected as MutationRejection<TArgs> | null

	const unsubscribe = controller.subscribe(() => {
		const snapshot = controller.getSnapshot()
		for (const listener of loadingListeners) {
			listener(snapshot.isLoading)
		}
		for (const listener of errorListeners) {
			listener(snapshot.error)
		}
		for (const listener of rejectedListeners) {
			listener(currentRejected())
		}
	})

	// Dispose the controller when the owning component unmounts, matching the
	// React (`useController`) and Vue (`onScopeDispose`) lifecycles. Guarded so
	// `createMutation()` can still be called outside a component (manual usage),
	// where `onDestroy` is unavailable and the caller owns disposal.
	try {
		onDestroy(() => {
			unsubscribe()
			controller.destroy()
		})
	} catch {
		// Not inside a component initialization — no lifecycle to hook into.
	}

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
		subscribeRejected: (fn) => {
			rejectedListeners.add(fn)
			fn(currentRejected())
			return () => rejectedListeners.delete(fn)
		},
		get rejected() {
			return currentRejected()
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
