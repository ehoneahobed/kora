import { KoraError } from '@korajs/core'
import { QueryStoreCache } from '@korajs/store'
import { getContext, setContext } from 'svelte'
import type { KoraAppLike, KoraContextValue } from './types'

const koraContextKey = Symbol('korajs-context')
const koraAppContextKey = Symbol('korajs-app')

export function setKoraContext(value: KoraContextValue): void {
	setContext(koraContextKey, value)
}

export function getKoraContext(): KoraContextValue {
	const context = getContext<KoraContextValue | undefined>(koraContextKey)
	if (!context) {
		throw new KoraError(
			'Kora context missing. Wrap your app with <KoraProvider app={kora}> or <KoraStoreProvider store={store}>.',
			'KORA_NOT_PROVIDED',
			{ fix: 'Wrap your app with <KoraProvider app={kora}> or <KoraStoreProvider store={store}>.' },
		)
	}
	return context
}

/** @deprecated Use {@link setKoraContext} via {@link KoraProvider} or {@link KoraStoreProvider}. */
export function setKoraAppContext(koraApp: KoraAppLike): void {
	setContext(koraAppContextKey, koraApp)
}

/** @deprecated Use {@link getKoraContext} and {@link getApp}. */
export function getKoraApp(): KoraAppLike {
	const app = getContext<KoraAppLike | undefined>(koraAppContextKey)
	if (!app) {
		throw new KoraError(
			'getKoraApp() requires setKoraAppContext(koraApp) on an ancestor.',
			'KORA_NOT_PROVIDED',
		)
	}
	return app
}

/**
 * Initialize Kora provider context after `app.ready`.
 *
 * @deprecated Prefer {@link KoraProvider} or {@link KoraStoreProvider} in root layout.
 */
export async function initKoraProvider(app: KoraAppLike): Promise<KoraContextValue> {
	await app.ready
	const queryStoreCache =
		typeof app.getQueryStoreCache === 'function' ? app.getQueryStoreCache() : new QueryStoreCache()
	const value: KoraContextValue = {
		store: app.getStore(),
		syncEngine: app.getSyncEngine(),
		app,
		events: app.events ?? null,
		subscribeSyncStatus: app.sync?.subscribeStatus ?? null,
		queryStoreCache,
	}
	setKoraContext(value)
	setKoraAppContext(app)
	return value
}
