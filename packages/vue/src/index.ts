import { KoraError } from '@korajs/core'
import { type App, inject } from 'vue'
import { koraAppInjectionKey } from './context'
import type { KoraAppLike } from './types'

export type { KoraAppHandle, KoraAppLike, KoraContextValue, KoraProviderProps } from './types'
export type { UseMutationOptions, UseMutationResult, UseQueryOptions, UseRichTextResult } from './types'

export { koraAppInjectionKey, koraContextKey, useKoraContext } from './context'
export { KoraProvider } from './components/kora-provider'
export { useQuery } from './composables/use-query'
export { useMutation } from './composables/use-mutation'
export { useSyncStatus } from './composables/use-sync-status'
export { useApp } from './composables/use-app'
export { useCollection } from './composables/use-collection'
export { useRichText } from './composables/use-rich-text'
export type { UseRichTextOptions } from './composables/use-rich-text'
export { usePresence, useCollaborators } from './composables/use-presence'

/**
 * Register a Kora app on a Vue application instance.
 *
 * @deprecated Prefer {@link KoraProvider} — `installKora` does not provide reactive
 * hook context (`useQuery`, `useSyncStatus`, etc.) until you migrate to `KoraProvider`.
 */
export function installKora(vueApp: App, koraApp: KoraAppLike): void {
	vueApp.provide(koraAppInjectionKey, koraApp)
}

/**
 * Access the Kora app from a component when using {@link installKora} only.
 * For reactive hooks, use {@link useApp} inside {@link KoraProvider}.
 */
export function useKoraApp(): KoraAppLike {
	const app = inject(koraAppInjectionKey)
	if (!app) {
		throw new KoraError(
			'useKoraApp() requires installKora(vueApp, koraApp) or <KoraProvider :app="app">.',
			'KORA_NOT_PROVIDED',
			{ fix: 'Use <KoraProvider :app="app"> and useApp() for full bindings.' },
		)
	}
	return app
}
