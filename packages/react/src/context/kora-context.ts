import type { Store } from '@korajs/store'
import { QueryStoreCache } from '@korajs/store'
import type { SyncEngine } from '@korajs/sync'
import {
	createContext,
	createElement,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import type { ReactNode } from 'react'
import type { KoraContextValue, KoraProviderProps } from '../types'

const KoraContext = createContext<KoraContextValue | null>(null)

/**
 * Provides Kora store and optional sync engine to all child components.
 * Must wrap any component that uses Kora hooks (useQuery, useMutation, etc.).
 */
function KoraProvider({
	app,
	store,
	syncEngine,
	fallback,
	children,
}: KoraProviderProps): ReactNode {
	const [resolvedStore, setResolvedStore] = useState<Store | null>(store ?? null)
	const [resolvedSync, setResolvedSync] = useState<SyncEngine | null>(syncEngine ?? null)
	const [ready, setReady] = useState(!app)
	const [initError, setInitError] = useState<Error | null>(null)
	const fallbackQueryStoreCache = useRef<QueryStoreCache | null>(null)

	if (!fallbackQueryStoreCache.current) {
		fallbackQueryStoreCache.current = new QueryStoreCache()
	}

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

	useEffect(() => {
		return () => {
			if (!app) {
				fallbackQueryStoreCache.current?.clear()
			}
		}
	}, [app])

	const contextValue = useMemo<KoraContextValue | null>(() => {
		if (!resolvedStore) {
			return null
		}
		if (fallbackQueryStoreCache.current === null) {
			fallbackQueryStoreCache.current = new QueryStoreCache()
		}
		return {
			store: resolvedStore,
			syncEngine: resolvedSync,
			app: app ?? null,
			events: app?.events ?? null,
			subscribeSyncStatus: app?.sync?.subscribeStatus ?? null,
			queryStoreCache:
				app && typeof app.getQueryStoreCache === 'function'
					? app.getQueryStoreCache()
					: fallbackQueryStoreCache.current,
		}
	}, [resolvedStore, resolvedSync, app])

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

	if (!contextValue) {
		throw new Error(
			'KoraProvider requires either an "app" or "store" prop. ' +
				'Pass a KoraApp from createApp() or a Store instance.',
		)
	}

	return createElement(KoraContext.Provider, { value: contextValue }, children)
}

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
