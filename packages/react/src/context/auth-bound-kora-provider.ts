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
	error?: (context: AuthBoundKoraErrorContext) => ReactNode
	children?: ReactNode
}

export interface AuthBoundKoraSession {
	/** The authenticated identity only. Access tokens are deliberately omitted. */
	userId: string
}

export interface AuthBoundKoraInitializationError {
	/** Stable Kora/DOM error code suitable for application-owned copy and recovery UI. */
	code: string
	name: string
	message: string
	/** Sanitized primitive metadata. Credential-shaped keys are always removed. */
	metadata: Readonly<Record<string, string | number | boolean | null>>
	/** Sanitized Error for logging; custom credential-bearing properties are omitted. */
	cause: Error
}

export interface AuthBoundKoraErrorContext {
	error: AuthBoundKoraInitializationError
	retry(): void
	session: AuthBoundKoraSession
}

const SENSITIVE_METADATA_KEY = /token|secret|password|authorization|cookie/i

/** Classify initialization failures without requiring applications to parse copy. */
export function classifyKoraInitializationError(error: unknown): AuthBoundKoraInitializationError {
	const candidate = error as {
		code?: unknown
		context?: unknown
		message?: unknown
		name?: unknown
		stack?: unknown
	}
	const message = typeof candidate?.message === 'string' ? candidate.message : String(error)
	const name = typeof candidate?.name === 'string' ? candidate.name : 'Error'
	const cause = new Error(message)
	cause.name = name
	if (typeof candidate?.stack === 'string') cause.stack = candidate.stack
	let code = typeof candidate?.code === 'string' ? candidate.code : 'INITIALIZATION_FAILED'
	if (code === 'INITIALIZATION_FAILED' && cause.name === 'QuotaExceededError') {
		code = 'STORAGE_QUOTA_EXCEEDED'
	}
	const metadata: Record<string, string | number | boolean | null> = {}
	if (candidate?.context && typeof candidate.context === 'object') {
		for (const [key, value] of Object.entries(candidate.context)) {
			if (SENSITIVE_METADATA_KEY.test(key)) continue
			if (
				typeof value === 'string' ||
				typeof value === 'number' ||
				typeof value === 'boolean' ||
				value === null
			) {
				metadata[key] = value
			}
		}
	}
	return { code, name: cause.name, message: cause.message, metadata, cause }
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
	error: renderError,
	children,
}: AuthBoundKoraProviderProps): ReactNode {
	const [app, setApp] = useState<(KoraAppLike & { close(): Promise<void> }) | null>(null)
	const [state, setState] = useState<AuthSyncState>({ state: 'loading' })
	const [initError, setInitError] = useState<{
		error: AuthBoundKoraInitializationError
		session: AuthBoundKoraSession
	} | null>(null)
	const active = useRef<(KoraAppLike & { close(): Promise<void> }) | null>(null)
	const createAppRef = useRef(createApp)
	createAppRef.current = createApp
	const activeUserId = useRef<string | null>(null)
	const generation = useRef(0)
	const transition = useRef(Promise.resolve())
	const reconcileRef = useRef<() => void>(() => {})

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
						void authClient.resolveSyncState?.().then((failedSession) => {
							if (
								!disposed &&
								currentGeneration === generation.current &&
								failedSession?.state === 'authenticated'
							) {
								setInitError({
									error: classifyKoraInitializationError(error),
									session: { userId: failedSession.userId },
								})
							}
						})
					}
				})
		}
		reconcileRef.current = reconcile
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
		if (renderError) {
			return renderError({
				error: initError.error,
				session: initError.session,
				retry: () => reconcileRef.current(),
			})
		}
		return createElement(
			'div',
			{ style: { color: 'red', padding: '1rem', fontFamily: 'monospace' } },
			createElement('strong', null, 'Kora initialization error: '),
			initError.error.message,
		)
	}
	if (state.state === 'signed-out' || state.state === 'anonymous') return signedOut
	if (!app) return fallback
	return createElement(KoraProvider, { app, fallback }, children)
}
