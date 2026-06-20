import { KoraError } from '@korajs/core'
import { type App, type InjectionKey, inject } from 'vue'
import type { KoraAppHandle } from './types'

export type { KoraAppHandle } from './types'

/** Vue injection key for the root Kora app instance. */
export const koraAppInjectionKey: InjectionKey<KoraAppHandle> = Symbol('korajs-app')

/**
 * Register a Kora app on a Vue application instance.
 * Call once after `createApp()` from korajs, typically in `main.ts`.
 */
export function installKora(vueApp: App, koraApp: KoraAppHandle): void {
	vueApp.provide(koraAppInjectionKey, koraApp)
}

/**
 * Access the Kora app from a component setup function.
 * Pair with {@link installKora} and `app.ready` before running queries.
 */
export function useKoraApp(): KoraAppHandle {
	const app = inject(koraAppInjectionKey)
	if (!app) {
		throw new KoraError(
			'useKoraApp() requires installKora(vueApp, koraApp) on the Vue application.',
			'KORA_NOT_PROVIDED',
			{
				fix: 'In main.ts: const kora = createApp({ schema }); installKora(vueApp, kora); await kora.ready',
			},
		)
	}
	return app
}
