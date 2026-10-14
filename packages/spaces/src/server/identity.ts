import type { ProductionHttpRouteRequest } from '@korajs/server'
import type { SpacesIdentity } from './spaces-routes'

/** The parts of `createKoraAuthServer()`'s result the adapter uses. */
export interface KoraAuthIdentitySource {
	routes: {
		authenticateAccess(token: string): Promise<{
			user: { id: string; email: string; emailVerified: boolean }
		} | null>
	}
	userStore: { findByEmail(email: string): Promise<{ id: string } | null> }
}

/** `spacesRoutes` identity options derived from an auth server. */
export interface SpacesIdentityOptions {
	identify(request: ProductionHttpRouteRequest): Promise<SpacesIdentity | null>
	findUserByEmail(email: string): Promise<string | null>
}

function bearerToken(request: ProductionHttpRouteRequest): string | null {
	const raw = request.headers?.authorization
	const header = Array.isArray(raw) ? raw[0] : raw
	if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) return null
	const token = header.slice(7).trim()
	return token.length > 0 ? token : null
}

/**
 * Identify spaces callers with `@korajs/auth`: the request's `Authorization: Bearer`
 * access token is checked like every other authenticated route (signature, expiry,
 * revocation, device), and the user's email and verification come from the user store.
 *
 * @param auth - The `createKoraAuthServer()` result
 *
 * @example
 * ```typescript
 * spacesRoutes({ sharing, ...koraAuthIdentity(auth), acceptUrl })
 * ```
 */
export function koraAuthIdentity(auth: KoraAuthIdentitySource): SpacesIdentityOptions {
	return {
		async identify(request) {
			const token = bearerToken(request)
			if (!token) return null
			const access = await auth.routes.authenticateAccess(token)
			if (!access) return null
			return {
				userId: access.user.id,
				email: access.user.email,
				emailVerified: access.user.emailVerified,
			}
		},
		async findUserByEmail(email) {
			return (await auth.userStore.findByEmail(email))?.id ?? null
		},
	}
}
