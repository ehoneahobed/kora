import type { Store } from '@kora/store'
import type { SyncEngine } from '@kora/sync'
import { createContext, createElement, useContext } from 'react'
import type { ReactNode } from 'react'
import type { KoraContextValue } from '../types'

const KoraContext = createContext<KoraContextValue | null>(null)

/**
 * Props for the KoraProvider component.
 */
interface KoraProviderProps {
	/** The local Kora store instance (must be open) */
	store: Store
	/** Optional sync engine for remote synchronization */
	syncEngine?: SyncEngine | null
	/** Child components (passed via createElement's third arg or JSX children) */
	children?: ReactNode
}

/**
 * Provides Kora store and optional sync engine to all child components.
 * Must wrap any component that uses Kora hooks (useQuery, useMutation, etc.).
 *
 * @example
 * ```typescript
 * import { KoraProvider } from '@kora/react'
 *
 * function App() {
 *   return createElement(KoraProvider, { store }, createElement(TodoList))
 * }
 * ```
 */
function KoraProvider({ store, syncEngine, children }: KoraProviderProps): ReactNode {
	const value: KoraContextValue = {
		store,
		syncEngine: syncEngine ?? null,
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
