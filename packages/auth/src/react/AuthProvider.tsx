import { createElement, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createAuthSession } from '../bindings/create-auth-session'
import type { AuthClient } from '../client/auth-client'
import { AuthContext } from './auth-context'

interface AuthProviderProps {
	client: AuthClient
	children: ReactNode
	fallback?: ReactNode
}

function AuthProvider({ client, children, fallback }: AuthProviderProps): ReactElement {
	const session = useMemo(() => createAuthSession(client), [client])

	useEffect(() => () => session.destroy(), [session])

	const snapshot = useSyncExternalStore(
		(onStoreChange) => session.subscribe(onStoreChange),
		() => session.getSnapshot(),
		() => session.getSnapshot(),
	)

	if (snapshot.initError) {
		return createElement(
			'div',
			{
				style: { color: 'red', padding: '1rem', fontFamily: 'monospace' },
				role: 'alert',
			},
			createElement('strong', null, 'Kora Auth initialization error: '),
			snapshot.initError.message,
		)
	}

	if (snapshot.isLoading && fallback !== undefined) {
		return fallback as ReactElement
	}

	const contextValue = {
		client,
		session,
		state: snapshot.state,
		isLoading: snapshot.isLoading,
	}

	return createElement(AuthContext.Provider, { value: contextValue }, children)
}

export { AuthProvider }
export type { AuthProviderProps }
