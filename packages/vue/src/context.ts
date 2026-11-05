import { KoraError } from '@korajs/core/lite'
import { type InjectionKey, type ShallowRef, inject } from 'vue'
import type { KoraAppLike, KoraContextValue } from './types'

export const koraContextKey: InjectionKey<ShallowRef<KoraContextValue | null>> =
	Symbol('korajs-context')

/** @deprecated Use {@link koraContextKey} with {@link KoraProvider}. */
export const koraAppInjectionKey: InjectionKey<KoraAppLike> = Symbol('korajs-app')

export function useKoraContext(): KoraContextValue {
	const contextRef = inject(koraContextKey)
	if (!contextRef?.value) {
		throw new KoraError(
			'useKoraContext() requires <KoraProvider>. Wrap your app root with KoraProvider.',
			'KORA_NOT_PROVIDED',
			{ fix: '<KoraProvider :app="app"><App /></KoraProvider>' },
		)
	}
	return contextRef.value
}

/**
 * The live context ref. The provider renders before the store opens, so a composable that
 * needs the store or the sync engine (not just the app or the query cache) reads this ref
 * inside a watcher and follows the swap from the pending store to the real one.
 */
export function useKoraContextRef(): ShallowRef<KoraContextValue> {
	const contextRef = inject(koraContextKey)
	if (!contextRef?.value) {
		throw new KoraError(
			'useKoraContext() requires <KoraProvider>. Wrap your app root with KoraProvider.',
			'KORA_NOT_PROVIDED',
			{ fix: '<KoraProvider :app="app"><App /></KoraProvider>' },
		)
	}
	return contextRef as ShallowRef<KoraContextValue>
}
