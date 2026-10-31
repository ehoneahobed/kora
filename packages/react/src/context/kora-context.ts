import { createPendingStore } from '@korajs/core/bindings'
import type { Store } from '@korajs/store'
import { QueryStoreCache } from '@korajs/store/lite'
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
 *
 * With an `app`, the children render at once, before the local database has opened
 * (first-visit parity, S4a): queries return `[]` until the store opens, and writes made
 * through `useMutation` wait for it (and survive a closed tab, via the write journal).
 * Pass `waitForStorage` to render `fallback` until `app.ready` instead.
 */
function KoraProvider({
	app,
	store,
	syncEngine,
	fallback,
	waitForStorage,
	children,
}: KoraProviderProps): ReactNode {
	// What the app opened with is remembered together with the app it belongs to, so a new `app`
	// prop never shows the previous app's store (or its error) for a moment.
	const [opened, setOpened] = useState<{
		app: KoraProviderProps['app']
		store: Store | null
		sync: SyncEngine | null
	} | null>(null)
	const [failed, setFailed] = useState<{ app: KoraProviderProps['app']; error: Error } | null>(null)
	const current = !!app && opened?.app === app ? opened : null
	const resolvedStore: Store | null = app ? (current?.store ?? null) : (store ?? null)
	const resolvedSync: SyncEngine | null = app ? (current?.sync ?? null) : (syncEngine ?? null)
	const ready = app ? current !== null : true
	const initError = failed !== null && failed.app === app ? failed.error : null
	// An app whose accessors work before `app.ready` renders its children at once; an older
	// or hand-made app object cannot, and keeps the gate.
	const renderEarly = !!app && waitForStorage !== true && app.collections !== undefined
	const pendingStore = useMemo<Store | null>(
		() => (renderEarly ? createPendingStore<Store>(app?.collections) : null),
		[renderEarly, app],
	)
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
				setOpened({ app, store: app.getStore(), sync: app.getSyncEngine() })
			})
			.catch((error: unknown) => {
				if (cancelled) return
				const err = error instanceof Error ? error : new Error(String(error))
				console.error('[Kora] Initialization failed:', err)
				setFailed({ app, error: err })
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
		const activeStore = resolvedStore ?? pendingStore
		if (!activeStore) {
			return null
		}
		if (fallbackQueryStoreCache.current === null) {
			fallbackQueryStoreCache.current = new QueryStoreCache()
		}
		return {
			store: activeStore,
			syncEngine: resolvedSync,
			app: app ?? null,
			events: app?.events ?? null,
			subscribeSyncStatus: app?.sync?.subscribeStatus ?? null,
			queryStoreCache:
				app && typeof app.getQueryStoreCache === 'function'
					? app.getQueryStoreCache()
					: fallbackQueryStoreCache.current,
		}
	}, [resolvedStore, pendingStore, resolvedSync, app])

	if (initError) {
		return createElement(
			'div',
			{ style: { color: 'red', padding: '1rem', fontFamily: 'monospace' } },
			createElement('strong', null, 'Kora initialization error: '),
			initError.message,
		)
	}

	if (!ready && !renderEarly) {
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

/**
 * The Kora context, or null outside a `<KoraProvider>`. For hooks that work without a
 * provider and only use it when present (`useMutation` tracks server rejections then).
 */
function useOptionalKoraContext(): KoraContextValue | null {
	return useContext(KoraContext)
}

export { KoraProvider, useKoraContext, useOptionalKoraContext }
