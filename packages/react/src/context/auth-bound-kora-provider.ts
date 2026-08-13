import type { AuthSyncBinding, AuthSyncState } from '@korajs/core/bindings'
import { createElement, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { KoraAppLike } from '../types'
import { KoraProvider } from './kora-context'

export interface AuthBoundKoraProviderProps {
	authClient: AuthSyncBinding
	createApp: (
		session: Extract<AuthSyncState, { state: 'authenticated' }>,
	) => KoraAppLike & { close(): Promise<void> }
	signedOut?: ReactNode
	fallback?: ReactNode
	children?: ReactNode
}

/**
 * Owns the security-sensitive app lifetime for shared-browser applications.
 * The previous app is fully closed before a different user's app is created,
 * and no stale provider tree is rendered across that boundary.
 */
export function AuthBoundKoraProvider({
	authClient,
	createApp,
	signedOut = null,
	fallback = null,
	children,
}: AuthBoundKoraProviderProps): ReactNode {
	const [app, setApp] = useState<(KoraAppLike & { close(): Promise<void> }) | null>(null)
	const [state, setState] = useState<AuthSyncState>({ state: 'loading' })
	const [initError, setInitError] = useState<Error | null>(null)
	const active = useRef<(KoraAppLike & { close(): Promise<void> }) | null>(null)
	const createAppRef = useRef(createApp)
	createAppRef.current = createApp
	const activeUserId = useRef<string | null>(null)
	const generation = useRef(0)
	const transition = useRef(Promise.resolve())

	useEffect(() => {
		let disposed = false
		const reconcile = (): void => {
			const currentGeneration = ++generation.current
			transition.current = transition.current
				.catch(() => {})
				.then(async () => {
					setInitError(null)
					const next =
						(await authClient.resolveSyncState?.()) ??
						({ state: 'signed-out', mayConnectAnonymously: false } as const)
					if (disposed || currentGeneration !== generation.current) return
					const previous = active.current
					// Same-user token/role refreshes stay on the same database and app instance.
					if (next.state === 'authenticated' && next.userId === activeUserId.current && previous) {
						setState(next)
						return
					}
					setApp(null)
					active.current = null
					activeUserId.current = null
					if (previous) await previous.close()
					if (disposed || currentGeneration !== generation.current) return
					setState(next)
					if (next.state !== 'authenticated') return
					const created = createAppRef.current(next)
					try {
						await created.ready
					} catch (error) {
						await created.close()
						throw error
					}
					if (disposed || currentGeneration !== generation.current) {
						await created.close()
						return
					}
					active.current = created
					activeUserId.current = next.userId
					setApp(created)
				})
				.catch((error: unknown) => {
					if (!disposed && currentGeneration === generation.current) {
						setInitError(error instanceof Error ? error : new Error(String(error)))
					}
				})
		}
		reconcile()
		const unsubscribe = authClient.subscribe?.(reconcile) ?? (() => {})
		return () => {
			disposed = true
			generation.current++
			unsubscribe()
			const previous = active.current
			active.current = null
			activeUserId.current = null
			if (previous) void previous.close()
		}
	}, [authClient])

	if (initError) {
		return createElement(
			'div',
			{ style: { color: 'red', padding: '1rem', fontFamily: 'monospace' } },
			createElement('strong', null, 'Kora initialization error: '),
			initError.message,
		)
	}
	if (state.state === 'signed-out' || state.state === 'anonymous') return signedOut
	if (!app) return fallback
	return createElement(KoraProvider, { app, fallback }, children)
}
