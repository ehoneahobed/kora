import type { Store } from '@korajs/store'
import type { SyncEngine } from '@korajs/sync'
import { createContext, createElement, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { KoraContextValue, KoraProviderProps } from '../types'

const KoraContext = createContext<KoraContextValue | null>(null)

/**
 * Provides Kora store and optional sync engine to all child components.
 * Must wrap any component that uses Kora hooks (useQuery, useMutation, etc.).
 *
 * Accepts either an `app` prop (recommended) or explicit `store` + `syncEngine` props.
 *
 * When using the `app` prop, KoraProvider waits for `app.ready` before rendering
 * children. A `fallback` prop can be provided to show content while initializing.
 *
 * @example
 * ```typescript
 * // Recommended: pass the app object directly
 * const app = createApp({ schema })
 * <KoraProvider app={app}><App /></KoraProvider>
 *
 * // Advanced: pass store and syncEngine explicitly
 * <KoraProvider store={store} syncEngine={syncEngine}><App /></KoraProvider>
 * ```
 */
function KoraProvider({
	app,
	store,
	syncEngine,
	fallback,
	children,
}: KoraProviderProps): ReactNode {
	const [resolvedStore, setResolvedStore] = useState<Store | null>(
		store ?? null,
	)
	const [resolvedSync, setResolvedSync] = useState<SyncEngine | null>(
		syncEngine ?? null,
	)
	// If no app prop, we're using the store prop and are ready immediately
	const [ready, setReady] = useState(!app)
	const [initError, setInitError] = useState<Error | null>(null)

	useEffect(() => {
		if (!app) return
		let cancelled = false
		app.ready
			.then(() => {
				if (cancelled) return
				setResolvedStore(app.getStore())
				setResolvedSync(app.getSyncEngine())
				setReady(true)
			})
			.catch((error: unknown) => {
				if (cancelled) return
				const err = error instanceof Error ? error : new Error(String(error))
				console.error('[Kora] Initialization failed:', err)
				setInitError(err)
			})
		return () => {
			cancelled = true
		}
	}, [app])

	if (initError) {
		return createElement(
			'div',
			{ style: { color: 'red', padding: '1rem', fontFamily: 'monospace' } },
			createElement('strong', null, 'Kora initialization error: '),
			initError.message,
		)
	}

	if (!ready) {
		return (fallback ?? null) as ReactNode
	}

	if (!resolvedStore) {
		throw new Error(
			'KoraProvider requires either an "app" or "store" prop. ' +
				'Pass a KoraApp from createApp() or a Store instance.',
		)
	}

	const value: KoraContextValue = {
		store: resolvedStore,
		syncEngine: resolvedSync,
	}
	return createElement(KoraContext.Provider, { value }, children)
}

/**
 * Internal hook to access the Kora context.
 * Throws if used outside of a KoraProvider.
 */
function useKoraContext(): KoraContextValue {
	const context = useContext(KoraContext)
	if (context === null) {
		throw new Error(
			'useKoraContext must be used within a <KoraProvider>. ' +
				'Wrap your component tree with <KoraProvider store={store}>.',
		)
	}
	return context
}

export { KoraProvider, useKoraContext }
