import {
	type SchemaDefinition,
	type ScopeMap,
	buildScopeMap,
	extractScopeValuesFromClaims,
} from '@korajs/core'
import type { AuthSyncBinding } from '@korajs/core/bindings'
import type { AuthState } from './auth-client'

/**
 * Minimal auth client surface required for sync integration.
 * Matches {@link AuthClient} without importing implementation details.
 */
export interface AuthSyncClient {
	getAccessToken(): Promise<string | null>
	onAuthChange?(callback: (state: AuthState) => void): () => void
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
	 * Application schema. When provided, scope maps are built automatically
	 * from JWT claims and schema scope declarations.
	 */
	schema?: SchemaDefinition
	/**
	 * Custom claim → flat scope value mapping.
	 * Defaults to {@link extractScopeValuesFromClaims}.
	 */
	scopeFromClaims?: (claims: Record<string, unknown>) => Record<string, unknown>
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

function readDeviceIdFromClaims(claims: Record<string, unknown>): string | undefined {
	const dev = claims.dev
	return typeof dev === 'string' && dev.length > 0 ? dev : undefined
}

/**
 * Creates a sync auth binding for `createApp({ sync: { authClient: binding } })`.
 *
 * Wires token refresh, automatic scope maps from JWT claims, and device-bound
 * sync node ids (`dev` claim) separate from the user id (`sub`).
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
	const { authClient, schema, scopeFromClaims } = options

	const binding: AuthSyncBinding = {
		auth: async () => {
			const token = await authClient.getAccessToken()
			return { token: token ?? '' }
		},
	}

	if (schema) {
		binding.resolveScopeMap = async () => {
			const token = await authClient.getAccessToken()
			if (!token) {
				return undefined
			}

			const claims = decodeJwtPayload(token)
			if (!claims) {
				return undefined
			}

			const scopeValues = scopeFromClaims
				? scopeFromClaims(claims)
				: extractScopeValuesFromClaims(schema, claims)

			return buildScopeMap(schema, scopeValues)
		}
	}

	binding.resolveNodeId = async () => {
		const token = await authClient.getAccessToken()
		if (!token) {
			return undefined
		}

		const claims = decodeJwtPayload(token)
		if (!claims) {
			return undefined
		}

		return readDeviceIdFromClaims(claims)
	}

	if (authClient.onAuthChange) {
		binding.subscribe = (listener) => authClient.onAuthChange?.(() => listener()) ?? (() => {})
	}

	return binding
}
