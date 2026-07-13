import { KoraError } from '@korajs/core'
import { type InjectionKey, inject, type ShallowRef } from 'vue'
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
