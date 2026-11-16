import { KoraError } from '@korajs/core/lite'
import { useKoraContext } from '../context'
import type { KoraAppLike } from '../types'

/**
 * Returns the typed Kora app from {@link KoraProvider}'s `app` prop.
 */
export function useApp<T extends KoraAppLike = KoraAppLike>(): T {
	const { app } = useKoraContext()
	if (!app) {
		throw new KoraError(
			'useApp() requires <KoraProvider :app="app">. Pass your createApp() result to the provider.',
			'KORA_NOT_PROVIDED',
		)
	}
	return app as T
}
