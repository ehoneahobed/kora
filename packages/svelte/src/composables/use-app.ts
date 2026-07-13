import { getKoraContext } from '../context'
import type { KoraAppLike } from '../types'

export function getApp<T extends KoraAppLike = KoraAppLike>(): T {
	const { app } = getKoraContext()
	if (!app) {
		throw new Error(
			'getApp() requires <KoraProvider app={kora}> or <KoraStoreProvider store={store}> with a createApp() instance.',
		)
	}
	return app as T
}

/** Alias for {@link getApp}. */
export const useApp = getApp
