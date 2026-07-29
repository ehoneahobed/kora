import { createElement, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createAuthSession } from '../bindings/create-auth-session'
import type { AuthSession } from '../bindings/create-auth-session'
import type { AuthClient } from '../client/auth-client'
import { AuthContext } from './auth-context'

interface AuthProviderProps {
	client: AuthClient
	children: ReactNode
	fallback?: ReactNode
}

type SessionEntry = {
	session: AuthSession
	refs: number
	destroyTimer: ReturnType<typeof setTimeout> | null
}

const sessionEntries = new WeakMap<AuthClient, SessionEntry>()

function getSessionEntry(client: AuthClient): SessionEntry {
	const existing = sessionEntries.get(client)
	if (existing) return existing

	const entry: SessionEntry = {
		session: createAuthSession(client),
		refs: 0,
		destroyTimer: null,
	}
	sessionEntries.set(client, entry)
	return entry
}

function retainSession(entry: SessionEntry): () => void {
	if (entry.destroyTimer) {
		clearTimeout(entry.destroyTimer)
		entry.destroyTimer = null
	}
	entry.refs++

	return () => {
		entry.refs = Math.max(0, entry.refs - 1)
		if (entry.refs > 0 || entry.destroyTimer) return

		// React StrictMode intentionally runs effect cleanup and setup back-to-back
		// on mount. Deferring disposal lets the second setup retain the same session,
		// while a real unmount still releases the auth subscription shortly after.
		entry.destroyTimer = setTimeout(() => {
			entry.destroyTimer = null
			if (entry.refs > 0) return
			entry.session.destroy()
			sessionEntries.delete(entry.session.client)
		}, 0)
	}
}

function AuthProvider({ client, children, fallback }: AuthProviderProps): ReactElement {
	const entry = useMemo(() => getSessionEntry(client), [client])
	const session = entry.session

	useEffect(() => retainSession(entry), [entry])

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
