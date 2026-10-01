import {
	type SchemaDefinition,
	type ScopeMap,
	buildScopeMap,
	extractScopeValuesFromClaims,
} from '@korajs/core'
import type { AuthSyncBinding, AuthSyncState } from '@korajs/core/bindings'
import type { AuthClientSession, AuthState } from './auth-client'

/**
 * Minimal auth client surface required for sync integration.
 * Matches {@link AuthClient} without importing implementation details.
 */
export interface AuthSyncClient {
	getAccessToken(): Promise<string | null>
	readonly state?: AuthState
	onAuthChange?(callback: (state: AuthState) => void): () => void
	/** Stored session freshness (authenticated-offline support). */
	readonly session?: AuthClientSession | null
	/** Unverified claims of the stored credentials, available offline. */
	getStoredClaims?(): Promise<Record<string, unknown> | null>
	/** Notifies when session freshness changes (fresh, offline, locked). */
	onSessionChange?(callback: (session: AuthClientSession | null) => void): () => void
}

/**
 * Sync binding returned by {@link createKoraAuthSync}.
 * Passed to `createApp({ sync: { authClient } })` in korajs.
 *
 * @deprecated Use {@link AuthSyncBinding} from `@korajs/core/bindings` or `@korajs/auth`.
 */
export type KoraAuthSyncBinding = AuthSyncBinding

/**
 * Configuration for {@link createKoraAuthSync}.
 */
export interface CreateKoraAuthSyncOptions {
	/** Kora auth client from `createKoraAuth()`. */
	authClient: AuthSyncClient
	/**
	 * Application schema. When provided, a client-side scope hint is built from
	 * token claims and schema scope declarations. The server only uses it to
	 * NARROW its own grant; it never authorizes anything.
	 */
	schema?: SchemaDefinition
	/**
	 * Custom claim → flat scope value mapping.
	 * Defaults to {@link extractScopeValuesFromClaims}.
	 */
	scopeFromClaims?: (claims: Record<string, unknown>) => Record<string, unknown>
	/** Signed-out behavior. Authenticated-only sync is suspended by default. */
	anonymous?: 'suspend' | 'allow'
}

/**
 * Decode JWT payload without signature verification (client-side scope hints only).
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split('.')
	if (parts.length !== 3) {
		return null
	}

	const payloadSegment = parts[1]
	if (payloadSegment === undefined) {
		return null
	}

	try {
		const base64 = payloadSegment.replace(/-/g, '+').replace(/_/g, '/')
		const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
		const json =
			typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('utf-8')
		const parsed: unknown = JSON.parse(json)
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return null
		}
		return parsed as Record<string, unknown>
	} catch {
		return null
	}
}

function readString(claims: Record<string, unknown> | null, key: string): string | undefined {
	const value = claims?.[key]
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Creates a sync auth binding for `createApp({ sync: { authClient: binding } })`.
 *
 * Wires token refresh, a client-side scope hint, and device-bound sync node ids
 * (`dev` claim) separate from the user id (`sub`).
 *
 * Offline-first: identity (user id, device id) comes from the stored session,
 * not from token freshness. While the auth server is unreachable the binding
 * keeps reporting the signed-in user (authenticated-offline, `token: null`), so
 * the user's own local database opens and the app stays usable; only the sync
 * transport waits for a fresh token.
 *
 * @example
 * ```typescript
 * import { createKoraAuth, createKoraAuthSync } from '@korajs/auth'
 * import { createApp } from 'korajs'
 *
 * const authClient = createKoraAuth({ serverUrl: 'https://api.example.com' })
 *
 * const app = createApp({
 *   schema,
 *   sync: {
 *     url: 'wss://api.example.com/kora-sync',
 *     authClient: createKoraAuthSync({ authClient, schema }),
 *   },
 * })
 * ```
 */
export function createKoraAuthSync(options: CreateKoraAuthSyncOptions): AuthSyncBinding {
	const { authClient, schema, scopeFromClaims, anonymous = 'suspend' } = options

	/**
	 * Claims of the session: from a fresh token when one can be minted, else from
	 * the stored credentials while the client is still signed in.
	 */
	const resolveClaims = async (): Promise<{
		claims: Record<string, unknown> | null
		token: string | null
	}> => {
		const token = await authClient.getAccessToken()
		if (token) return { claims: decodeJwtPayload(token), token }
		if (authClient.state === 'unauthenticated' || !authClient.getStoredClaims) {
			return { claims: null, token: null }
		}
		return { claims: await authClient.getStoredClaims(), token: null }
	}

	const binding: AuthSyncBinding = {
		auth: async () => {
			const token = await authClient.getAccessToken()
			return { token: token ?? '' }
		},
	}

	binding.resolveSyncState = async (): Promise<AuthSyncState> => {
		if (authClient.state === 'loading') return { state: 'loading' }
		const { claims, token } = await resolveClaims()
		const userId = readString(claims, 'sub')
		if (!userId) {
			return anonymous === 'allow'
				? { state: 'anonymous', mayConnectAnonymously: true }
				: { state: 'signed-out', mayConnectAnonymously: false }
		}
		const deviceId = readString(claims, 'dev')
		if (token) {
			return { state: 'authenticated', userId, token, ...(deviceId ? { deviceId } : {}) }
		}
		return {
			state: 'authenticated',
			userId,
			token: null,
			offline: true,
			locked: authClient.session?.status === 'locked',
			...(deviceId ? { deviceId } : {}),
		}
	}

	if (schema) {
		binding.resolveScopeMap = async () => {
			const { claims } = await resolveClaims()
			if (!claims) {
				return undefined
			}

			const scopeValues = scopeFromClaims
				? scopeFromClaims(claims)
				: extractScopeValuesFromClaims(schema, claims)

			return buildScopeMap(schema, scopeValues) as ScopeMap
		}
	}

	binding.resolveNodeId = async () => {
		const { claims } = await resolveClaims()
		return readString(claims, 'dev')
	}

	binding.resolveUserId = async () => {
		const { claims } = await resolveClaims()
		return readString(claims, 'sub')
	}

	if (authClient.onAuthChange || authClient.onSessionChange) {
		binding.subscribe = (listener) => {
			const offAuth = authClient.onAuthChange?.(() => listener()) ?? (() => {})
			const offSession = authClient.onSessionChange?.(() => listener()) ?? (() => {})
			return () => {
				offAuth()
				offSession()
			}
		}
	}

	return binding
}
