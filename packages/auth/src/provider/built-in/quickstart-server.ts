import { randomUUID } from 'node:crypto'
import { KoraError } from '@korajs/core'
import {
	InMemoryTokenRevocationStore,
	TokenManager,
	type TokenManagerConfig,
	type TokenRevocationStore,
} from '../../tokens/token-manager'
import type { AuthTokens } from '../../types'
import {
	DuplicateLinkedIdentityError,
	InMemoryLinkedIdentityStore,
	type LinkedIdentityStore,
} from '../oauth/linked-identity-store'
import { OAuthManager, type OAuthManagerConfig, generateOAuthBinding } from '../oauth/oauth-flow'
import {
	type LinkedIdentity,
	OAuthError,
	type OAuthProviderConfig,
	type OAuthUserInfo,
} from '../oauth/oauth-types'
import {
	type AuthRevocationEvent,
	type AuthRouteResponse,
	type AuthRoutesConfig,
	BuiltInAuthRoutes,
	type ChallengeStore,
	type RateLimiter,
} from './auth-routes'
import { hashPassword } from './password-hash'
import type { SyncAuthProvider, SyncScopeOptions } from './sync-scopes'
import {
	type AuthUser,
	DeviceOwnershipError,
	InMemoryUserStore,
	type StoredUser,
	type UserStore,
} from './user-store'

type SignUpBody = Parameters<BuiltInAuthRoutes['handleSignUp']>[0]
type SignInBody = Parameters<BuiltInAuthRoutes['handleSignIn']>[0]
type RefreshBody = Parameters<BuiltInAuthRoutes['handleRefresh']>[0]
type SignOutBody = Parameters<BuiltInAuthRoutes['handleSignOut']>[1]
type DeviceRegisterBody = Parameters<BuiltInAuthRoutes['handleDeviceRegister']>[1]
type DeviceVerifyBody = Parameters<BuiltInAuthRoutes['handleDeviceVerify']>[0]

export interface KoraAuthHttpRequest {
	method: string
	path: string
	body?: unknown
	headers?: Record<string, string | string[] | undefined>
	query?: Record<string, string | string[] | undefined>
	ip?: string
}

export interface OAuthServerConfig extends Omit<OAuthManagerConfig, 'providers'> {
	providers: OAuthProviderConfig[]
	linkedIdentityStore?: LinkedIdentityStore
	/** Create a Kora user on first OAuth sign-in. Defaults to true. */
	createNewUsers?: boolean
	/**
	 * Link OAuth identities to an existing Kora user with the same verified email.
	 * Defaults to false so apps choose this trust boundary explicitly.
	 */
	autoLinkVerifiedEmail?: boolean
	/**
	 * Allow a user to unlink their last OAuth identity. Defaults to false to avoid
	 * locking out OAuth-created accounts that do not have a known password.
	 */
	allowUnlinkLastIdentity?: boolean
}

export interface CreateKoraAuthServerOptions extends SyncScopeOptions {
	/** Existing user store. Defaults to InMemoryUserStore for development. */
	userStore?: UserStore
	/**
	 * Token revocation store. Defaults to the user store's own revocation store
	 * (`userStore.getTokenRevocationStore()`), so revocations persist and are shared
	 * exactly as far as the users are.
	 */
	revocationStore?: TokenRevocationStore
	/**
	 * Allow in-memory user or revocation stores when `NODE_ENV=production`.
	 * In-memory stores lose every account and every revocation on restart and are
	 * not shared between instances, so production refuses them by default.
	 */
	allowInMemory?: boolean
	/** Existing token manager. Overrides `jwtSecret` and `tokenManager` options. */
	tokenManager?: TokenManager
	/** JWT secret. Required in production when `tokenManager` is not provided. */
	jwtSecret?: string | string[]
	/** Additional TokenManager options. */
	tokenManagerOptions?: Omit<TokenManagerConfig, 'secret'>
	/** Auth HTTP path prefix. Defaults to `/auth`. */
	path?: string
	/** OAuth provider routes and account-linking storage. */
	oauth?: OAuthServerConfig
	challengeStore?: ChallengeStore
	rateLimiter?: RateLimiter
}

/**
 * The part of `KoraSyncServer` the auth server needs to end live sessions.
 * Structural, so `@korajs/auth` does not depend on `@korajs/server`.
 */
export interface SyncSessionTerminator {
	terminateSessions(filter: { userId?: string; deviceId?: string }): unknown
}

export interface KoraAuthServer {
	routes: BuiltInAuthRoutes
	userStore: UserStore
	tokenManager: TokenManager
	oauth?: OAuthManager
	linkedIdentityStore?: LinkedIdentityStore
	/** Sync auth provider with server-derived scopes (pass to `KoraSyncServer`). */
	auth: SyncAuthProvider
	handleRequest(request: KoraAuthHttpRequest): Promise<AuthRouteResponse<unknown>>
	/**
	 * Revoke every credential a user holds (call after a password change made
	 * outside these routes, an admin action or an account deletion).
	 */
	revokeAllForUser(userId: string): Promise<void>
	/** Subscribe to credential revocations. Returns an unsubscribe function. */
	onRevoke(listener: (event: AuthRevocationEvent) => void | Promise<void>): () => void
	/**
	 * End live sync sessions when their credentials are revoked (AUTH-11).
	 * Requires a sync server exposing `terminateSessions({ userId, deviceId })`.
	 * Returns an unsubscribe function.
	 */
	bindSyncServer(server: SyncSessionTerminator): () => void
}

/**
 * Thrown by `createKoraAuthServer` in production when a store would silently
 * lose accounts or revocations on restart.
 */
export class InMemoryAuthStoreError extends KoraError {
	constructor(which: 'userStore' | 'revocationStore') {
		super(
			`createKoraAuthServer refuses an in-memory ${which} in production: it loses every ${
				which === 'userStore' ? 'account' : 'sign-out and revocation'
			} on restart and is not shared between instances.`,
			'IN_MEMORY_AUTH_STORE',
			{
				which,
				fix: 'Pass a persistent store (createSqliteUserStore / createPostgresUserStore, whose getTokenRevocationStore() is used automatically), or set allowInMemory: true for a throwaway deployment.',
			},
		)
		this.name = 'InMemoryAuthStoreError'
	}
}

interface OAuthServerRuntime {
	manager: OAuthManager
	linkedIdentityStore: LinkedIdentityStore
	createNewUsers: boolean
	autoLinkVerifiedEmail: boolean
	allowUnlinkLastIdentity: boolean
}

/**
 * Create the built-in Kora auth server with production-shaped defaults.
 *
 * Simple apps can use `handleRequest()` for all `/auth/*` HTTP endpoints and
 * pass `auth` directly to `createProductionServer({ syncOptions: { auth } })`.
 */
export function createKoraAuthServer(options: CreateKoraAuthServerOptions = {}): KoraAuthServer {
	const userStore = options.userStore ?? new InMemoryUserStore()
	const revocationStore =
		options.revocationStore ??
		options.tokenManagerOptions?.revocationStore ??
		userStore.getTokenRevocationStore?.() ??
		new InMemoryTokenRevocationStore()
	const tokenManager = options.tokenManager ?? createDefaultTokenManager(options, revocationStore)
	if (isProduction() && !options.allowInMemory) {
		if (userStore instanceof InMemoryUserStore) throw new InMemoryAuthStoreError('userStore')
		const effectiveRevocation = tokenManager.getRevocationStore()
		if (!effectiveRevocation || effectiveRevocation instanceof InMemoryTokenRevocationStore) {
			throw new InMemoryAuthStoreError('revocationStore')
		}
	}
	const routes = new BuiltInAuthRoutes({
		userStore,
		tokenManager,
		challengeStore: options.challengeStore,
		rateLimiter: options.rateLimiter,
	})
	const oauth = options.oauth ? createOAuthRuntime(options.oauth) : undefined
	const path = normalizePath(options.path ?? '/auth')

	return {
		routes,
		userStore,
		tokenManager,
		oauth: oauth?.manager,
		linkedIdentityStore: oauth?.linkedIdentityStore,
		auth: routes.toSyncAuthProvider({
			scopeValues: options.scopeValues,
			resolveScopes: options.resolveScopes,
		}),
		handleRequest(request) {
			return handleAuthRequest(routes, path, request, oauth, userStore, tokenManager)
		},
		revokeAllForUser(userId) {
			return routes.revokeAllForUser(userId)
		},
		onRevoke(listener) {
			return routes.onRevoke(listener)
		},
		bindSyncServer(server) {
			return routes.onRevoke((event) => {
				if (event.kind === 'user') {
					server.terminateSessions({ userId: event.userId })
				} else {
					server.terminateSessions({ userId: event.userId, deviceId: event.deviceId })
				}
			})
		},
	}
}

function createDefaultTokenManager(
	options: CreateKoraAuthServerOptions,
	revocationStore: TokenRevocationStore,
): TokenManager {
	const secret = options.jwtSecret ?? readEnvSecret()
	if (!secret && isProduction()) {
		throw new Error(
			'createKoraAuthServer requires jwtSecret in production. Set KORA_AUTH_SECRET or pass jwtSecret.',
		)
	}

	if (!secret) {
		// Outside production we fall back to an ephemeral random secret so local
		// development works with zero setup. Warn loudly: this secret is
		// regenerated on every process start, so every previously issued token is
		// silently invalidated on restart. That is a confusing failure mode if it
		// ever reaches a deployed environment where NODE_ENV was simply never set
		// to "production" — the production guard above only fires when NODE_ENV
		// explicitly equals "production".
		console.warn(
			'[kora] No JWT secret configured; using an ephemeral random secret. ' +
				'Every token is invalidated when the process restarts. ' +
				'Set KORA_AUTH_SECRET or pass jwtSecret to createKoraAuthServer for stable sessions.',
		)
	}

	return new TokenManager({
		secret: secret ?? TokenManager.generateSecret(),
		...options.tokenManagerOptions,
		revocationStore,
	})
}

function createOAuthRuntime(config: OAuthServerConfig): OAuthServerRuntime {
	return {
		manager: new OAuthManager(config),
		linkedIdentityStore: config.linkedIdentityStore ?? new InMemoryLinkedIdentityStore(),
		createNewUsers: config.createNewUsers ?? true,
		autoLinkVerifiedEmail: config.autoLinkVerifiedEmail ?? false,
		allowUnlinkLastIdentity: config.allowUnlinkLastIdentity ?? false,
	}
}

async function handleAuthRequest(
	routes: BuiltInAuthRoutes,
	pathPrefix: string,
	request: KoraAuthHttpRequest,
	oauth: OAuthServerRuntime | undefined,
	userStore: UserStore,
	tokenManager: TokenManager,
): Promise<AuthRouteResponse<unknown>> {
	const path = normalizePath(request.path)
	const relativePath = path === pathPrefix ? '/' : path.slice(pathPrefix.length)
	const method = request.method.toUpperCase()
	const body = isRecord(request.body) ? request.body : {}
	const token = extractBearerToken(request.headers)

	if (path !== pathPrefix && !path.startsWith(`${pathPrefix}/`)) {
		return notFound()
	}

	if (relativePath.startsWith('/oauth/')) {
		return handleOAuthRequest({
			oauth,
			routes,
			userStore,
			tokenManager,
			relativePath,
			method,
			body,
			query: request.query,
			token,
			cookieBinding: readCookie(request.headers, OAUTH_BINDING_COOKIE),
			pathPrefix,
		})
	}

	if (method === 'POST' && relativePath === '/signup') {
		return routes.handleSignUp(body as SignUpBody, request.ip)
	}
	if (method === 'POST' && relativePath === '/signin') {
		return routes.handleSignIn(body as SignInBody, request.ip)
	}
	if (method === 'POST' && relativePath === '/refresh') {
		return routes.handleRefresh(body as RefreshBody)
	}
	if (method === 'POST' && relativePath === '/signout') {
		return routes.handleSignOut(token, body as SignOutBody)
	}
	if (method === 'GET' && relativePath === '/me') {
		return routes.handleGetMe(token)
	}
	if (method === 'GET' && relativePath === '/devices') {
		return routes.handleListDevices(token)
	}
	if (method === 'POST' && relativePath === '/device/register') {
		return routes.handleDeviceRegister(token, body as DeviceRegisterBody)
	}
	if (method === 'POST' && relativePath === '/device/challenge') {
		const deviceId = typeof body.deviceId === 'string' ? body.deviceId : ''
		return routes.handleDeviceChallenge(token, deviceId)
	}
	if (method === 'POST' && relativePath === '/device/verify') {
		return routes.handleDeviceVerify(body as DeviceVerifyBody)
	}
	if (method === 'DELETE' && relativePath.startsWith('/device/')) {
		return routes.handleRevokeDevice(token, relativePath.slice('/device/'.length))
	}

	return notFound()
}

async function handleOAuthRequest(params: {
	oauth: OAuthServerRuntime | undefined
	routes: BuiltInAuthRoutes
	userStore: UserStore
	tokenManager: TokenManager
	relativePath: string
	method: string
	body: Record<string, unknown>
	query: KoraAuthHttpRequest['query']
	token: string
	cookieBinding: string | undefined
	pathPrefix: string
}): Promise<AuthRouteResponse<unknown>> {
	const {
		oauth,
		routes,
		userStore,
		tokenManager,
		relativePath,
		method,
		body,
		query,
		token,
		cookieBinding,
		pathPrefix,
	} = params
	if (!oauth) {
		return notFound()
	}

	try {
		if (method === 'GET' && relativePath === '/oauth/links') {
			const authUser = await requireAuthUser(routes, token)
			if ('status' in authUser) return authUser
			const identities = await oauth.linkedIdentityStore.findByUser(authUser.id)
			return { status: 200, body: { data: identities } }
		}

		const match = /^\/oauth\/([^/]+)(?:\/(callback|link|link\/start))?$/.exec(relativePath)
		if (!match) {
			return notFound()
		}

		const provider = decodeURIComponent(match[1] as string)
		const action = match[2]

		// Every flow is bound to its purpose and to the initiating client (AUTH-3):
		// a random binding goes to the client as an HttpOnly cookie (web) and in the
		// body (native/PKCE apps keep it in memory); only its hash is stored.
		if (method === 'GET' && !action) {
			const binding = generateOAuthBinding()
			const { url, state } = await oauth.manager.getAuthorizationUrl(
				provider,
				metadataFromQuery(query),
				{ purpose: 'signin', binding },
			)
			return flowStarted(url, state, binding, pathPrefix)
		}

		if (method === 'POST' && action === 'link/start') {
			const authUser = await requireAuthUser(routes, token)
			if ('status' in authUser) return authUser
			const binding = generateOAuthBinding()
			const { url, state } = await oauth.manager.getAuthorizationUrl(provider, undefined, {
				purpose: 'link',
				userId: authUser.id,
				binding,
			})
			return flowStarted(url, state, binding, pathPrefix)
		}

		if ((method === 'GET' || method === 'POST') && action === 'callback') {
			const code = readString(method === 'GET' ? queryValue(query, 'code') : body.code)
			const state = readString(method === 'GET' ? queryValue(query, 'state') : body.state)
			if (!code || !state) {
				return { status: 400, body: { error: 'OAuth callback requires code and state.' } }
			}
			return await completeOAuthSignIn({
				oauth,
				userStore,
				tokenManager,
				provider,
				code,
				state,
				binding: readString(body.binding) ?? cookieBinding,
				deviceId: readString(body.deviceId),
				devicePublicKey: readString(body.devicePublicKey),
			})
		}

		if (method === 'POST' && action === 'link') {
			const authUser = await requireAuthUser(routes, token)
			if ('status' in authUser) return authUser
			const code = readString(body.code)
			const state = readString(body.state)
			if (!code || !state) {
				return { status: 400, body: { error: 'OAuth linking requires code and state.' } }
			}
			return await linkOAuthIdentity(
				oauth,
				authUser.id,
				provider,
				code,
				state,
				readString(body.binding) ?? cookieBinding,
			)
		}

		if (method === 'DELETE' && action === 'link') {
			const authUser = await requireAuthUser(routes, token)
			if ('status' in authUser) return authUser
			const identities = await oauth.linkedIdentityStore.findByUser(authUser.id)
			if (!oauth.allowUnlinkLastIdentity && identities.length <= 1) {
				return {
					status: 409,
					body: {
						error:
							'Cannot unlink the last OAuth identity unless allowUnlinkLastIdentity is enabled.',
					},
				}
			}
			await oauth.linkedIdentityStore.delete(authUser.id, provider)
			return { status: 200, body: { data: { ok: true } } }
		}
	} catch (error) {
		return oauthErrorResponse(error)
	}

	return notFound()
}

async function completeOAuthSignIn(params: {
	oauth: OAuthServerRuntime
	userStore: UserStore
	tokenManager: TokenManager
	provider: string
	code: string
	state: string
	binding: string | undefined
	deviceId?: string
	devicePublicKey?: string
}): Promise<AuthRouteResponse<{ user: AuthUser; tokens: AuthTokens; identity: LinkedIdentity }>> {
	const { oauth, userStore, tokenManager, provider, code, state, deviceId, devicePublicKey } =
		params
	const { userInfo } = await oauth.manager.handleCallback(provider, code, state, {
		purpose: 'signin',
		binding: params.binding,
	})
	const linkedIdentity = await oauth.linkedIdentityStore.findByProvider(
		userInfo.provider,
		userInfo.providerId,
	)

	let user: AuthUser
	let identity: LinkedIdentity
	if (linkedIdentity) {
		const storedUser = await userStore.findById(linkedIdentity.userId)
		if (!storedUser) {
			return { status: 409, body: { error: 'Linked OAuth account has no matching user.' } }
		}
		user = toAuthUser(storedUser)
		identity = linkedIdentity
	} else {
		const resolved = await resolveOAuthUser(userStore, oauth, userInfo)
		if ('status' in resolved) return resolved
		user = resolved
		identity = await oauth.linkedIdentityStore.create({
			userId: user.id,
			provider: userInfo.provider,
			providerUserId: userInfo.providerId,
			email: userInfo.email,
		})
	}

	// Never trust a device id carried in OAuth state metadata (it comes from the
	// query string of whoever started the flow), and never default to a per-user
	// id that every browser of the user would share (AUTH-3, AUTH-5).
	const resolvedDeviceId = deviceId ?? `dev-${randomUUID()}`
	try {
		await userStore.registerDevice({
			id: resolvedDeviceId,
			userId: user.id,
			publicKey: devicePublicKey ?? '',
			name: deviceId ? 'Device' : 'Browser',
		})
	} catch (error) {
		if (error instanceof DeviceOwnershipError) {
			return {
				status: 409,
				body: {
					error: 'This device id is registered to another account.',
					code: 'DEVICE_OWNERSHIP_CONFLICT',
				},
			}
		}
		throw error
	}

	const tokens = tokenManager.issueTokens(user.id, resolvedDeviceId)
	return { status: 200, body: { data: { user, tokens, identity } } }
}

async function resolveOAuthUser(
	userStore: UserStore,
	oauth: OAuthServerRuntime,
	userInfo: OAuthUserInfo,
): Promise<AuthUser | AuthRouteResponse<never>> {
	if (!userInfo.email) {
		return { status: 400, body: { error: 'OAuth provider did not return an email address.' } }
	}

	const existingUser = await userStore.findByEmail(userInfo.email)
	if (existingUser) {
		if (oauth.autoLinkVerifiedEmail && userInfo.emailVerified) {
			return toAuthUser(existingUser)
		}
		return {
			status: 409,
			body: { error: 'OAuth account is not linked. Sign in and link this provider first.' },
		}
	}

	if (!oauth.createNewUsers) {
		return { status: 403, body: { error: 'OAuth sign-up is disabled for this application.' } }
	}

	const credential = await hashPassword(randomUUID())
	const user = await userStore.createUser({
		email: userInfo.email,
		passwordHash: credential.hash,
		salt: credential.salt,
		name: userInfo.name ?? userInfo.email.split('@')[0] ?? userInfo.email,
	})
	if (userInfo.emailVerified) {
		await userStore.setEmailVerified(user.id, true)
		return { ...user, emailVerified: true }
	}
	return user
}

async function linkOAuthIdentity(
	oauth: OAuthServerRuntime,
	userId: string,
	provider: string,
	code: string,
	state: string,
	binding: string | undefined,
): Promise<AuthRouteResponse<LinkedIdentity>> {
	const { userInfo } = await oauth.manager.handleCallback(provider, code, state, {
		purpose: 'link',
		userId,
		binding,
	})
	const existing = await oauth.linkedIdentityStore.findByProvider(
		userInfo.provider,
		userInfo.providerId,
	)
	if (existing && existing.userId !== userId) {
		return { status: 409, body: { error: 'This OAuth account is already linked to another user.' } }
	}
	if (existing) {
		return { status: 200, body: { data: existing } }
	}

	const identity = await oauth.linkedIdentityStore.create({
		userId,
		provider: userInfo.provider,
		providerUserId: userInfo.providerId,
		email: userInfo.email,
	})
	return { status: 201, body: { data: identity } }
}

async function requireAuthUser(
	routes: BuiltInAuthRoutes,
	token: string,
): Promise<AuthUser | AuthRouteResponse<never>> {
	if (!token) {
		return {
			status: 401,
			body: { error: 'Authorization token required.', code: 'ACCESS_TOKEN_REQUIRED' },
		}
	}
	// The same revocation-aware check every route uses (AUTH-2, AUTH-8).
	const access = await routes.authenticateAccess(token)
	if (!access) {
		return {
			status: 401,
			body: { error: 'Invalid or expired token.', code: 'ACCESS_TOKEN_INVALID' },
		}
	}
	return toAuthUser(access.user)
}

const OAUTH_BINDING_COOKIE = 'kora_oauth_binding'

function flowStarted(
	url: string,
	state: string,
	binding: string,
	pathPrefix: string,
): AuthRouteResponse<{ url: string; state: string; binding: string }> {
	return {
		status: 200,
		body: { data: { url, state, binding } },
		headers: {
			'Set-Cookie': `${OAUTH_BINDING_COOKIE}=${binding}; Path=${pathPrefix}/oauth; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
		},
	}
}

function readCookie(headers: KoraAuthHttpRequest['headers'], name: string): string | undefined {
	const raw = headers?.cookie ?? headers?.Cookie
	const value = Array.isArray(raw) ? raw.join('; ') : raw
	if (!value) return undefined
	for (const part of value.split(';')) {
		const [key, ...rest] = part.trim().split('=')
		if (key === name) return rest.join('=')
	}
	return undefined
}

function extractBearerToken(headers: KoraAuthHttpRequest['headers']): string {
	const authorization = headers?.authorization ?? headers?.Authorization
	const value = Array.isArray(authorization) ? authorization[0] : authorization
	if (!value?.startsWith('Bearer ')) {
		return ''
	}
	return value.slice('Bearer '.length).trim()
}

function normalizePath(path: string): string {
	const withoutQuery = path.split('?')[0] || '/'
	const normalized = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`
	return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

function metadataFromQuery(
	query: KoraAuthHttpRequest['query'],
): Record<string, unknown> | undefined {
	if (!query) return undefined
	const metadata: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(query)) {
		if (key === 'code' || key === 'state') continue
		if (value !== undefined) {
			metadata[key] = value
		}
	}
	return Object.keys(metadata).length > 0 ? metadata : undefined
}

function queryValue(
	query: KoraAuthHttpRequest['query'],
	key: string,
): string | string[] | undefined {
	return query?.[key]
}

function readString(value: unknown): string | undefined {
	if (typeof value === 'string' && value.length > 0) return value
	if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) {
		return value[0]
	}
	return undefined
}

function oauthErrorResponse(error: unknown): AuthRouteResponse<never> {
	if (error instanceof DuplicateLinkedIdentityError) {
		return { status: 409, body: { error: error.message } }
	}
	if (error instanceof OAuthError) {
		const status = error.code === 'OAUTH_PROVIDER_NOT_FOUND' ? 404 : 400
		return { status, body: { error: error.message } }
	}
	throw error
}

function toAuthUser(user: StoredUser): AuthUser {
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		emailVerified: user.emailVerified,
		createdAt: user.createdAt,
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function notFound(): AuthRouteResponse<never> {
	return { status: 404, body: { error: 'Not found' } }
}

function readEnvSecret(): string | undefined {
	if (typeof process === 'undefined') {
		return undefined
	}
	// Treat an explicitly empty or whitespace-only KORA_AUTH_SECRET as "not set"
	// rather than as a real (invalid) secret. Otherwise an empty string slips past
	// the nullish-coalescing fallback below and reaches TokenManager, which throws
	// on secrets shorter than 32 chars — turning a blank env var into a hard crash
	// instead of the intended dev fallback / production guard.
	const value = process.env.KORA_AUTH_SECRET
	return value && value.trim().length > 0 ? value : undefined
}

function isProduction(): boolean {
	return typeof process !== 'undefined' && process.env.NODE_ENV === 'production'
}
