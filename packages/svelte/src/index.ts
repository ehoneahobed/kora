import { KoraError } from '@korajs/core'
import { getContext, setContext } from 'svelte'
import type { KoraAppHandle } from './types'

export type { KoraAppHandle } from './types'

const koraAppContextKey = Symbol('korajs-app')

/**
 * Set the Kora app in Svelte context (call from a root layout or `+layout.svelte`).
 */
export function setKoraAppContext(koraApp: KoraAppHandle): void {
	setContext(koraAppContextKey, koraApp)
}

/**
 * Read the Kora app from Svelte context in child components.
 */
export function getKoraApp(): KoraAppHandle {
	const app = getContext<KoraAppHandle | undefined>(koraAppContextKey)
	if (!app) {
		throw new KoraError(
			'getKoraApp() requires setKoraAppContext(koraApp) on an ancestor component.',
			'KORA_NOT_PROVIDED',
			{
				fix: 'In +layout.svelte: setKoraAppContext(kora); await kora.ready before queries.',
			},
		)
	}
	return app
}
