import {
	InMemoryTokenRevocationStore,
	TokenManager,
	type TokenManagerConfig,
} from '../../tokens/token-manager'
import {
	type AuthRouteResponse,
	type AuthRoutesConfig,
	BuiltInAuthRoutes,
	type ChallengeStore,
	type RateLimiter,
} from './auth-routes'
import { InMemoryUserStore, type UserStore } from './user-store'

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
	ip?: string
}

export interface CreateKoraAuthServerOptions {
	/** Existing user store. Defaults to InMemoryUserStore for development. */
	userStore?: UserStore
	/** Existing token manager. Overrides `jwtSecret` and `tokenManager` options. */
	tokenManager?: TokenManager
	/** JWT secret. Required in production when `tokenManager` is not provided. */
	jwtSecret?: string | string[]
	/** Additional TokenManager options. */
	tokenManagerOptions?: Omit<TokenManagerConfig, 'secret'>
	/** Auth HTTP path prefix. Defaults to `/auth`. */
	path?: string
	challengeStore?: ChallengeStore
	rateLimiter?: RateLimiter
}

export interface KoraAuthServer {
	routes: BuiltInAuthRoutes
	userStore: UserStore
	tokenManager: TokenManager
	auth: ReturnType<BuiltInAuthRoutes['toSyncAuthProvider']>
	handleRequest(request: KoraAuthHttpRequest): Promise<AuthRouteResponse<unknown>>
}

/**
 * Create the built-in Kora auth server with production-shaped defaults.
 *
 * Simple apps can use `handleRequest()` for all `/auth/*` HTTP endpoints and
 * pass `auth` directly to `createProductionServer({ syncOptions: { auth } })`.
 */
export function createKoraAuthServer(options: CreateKoraAuthServerOptions = {}): KoraAuthServer {
	const userStore = options.userStore ?? new InMemoryUserStore()
	const tokenManager = options.tokenManager ?? createDefaultTokenManager(options)
	const routes = new BuiltInAuthRoutes({
		userStore,
		tokenManager,
		challengeStore: options.challengeStore,
		rateLimiter: options.rateLimiter,
	})
	const path = normalizePath(options.path ?? '/auth')

	return {
		routes,
		userStore,
		tokenManager,
		auth: routes.toSyncAuthProvider(),
		handleRequest(request) {
			return handleAuthRequest(routes, path, request)
		},
	}
}

function createDefaultTokenManager(options: CreateKoraAuthServerOptions): TokenManager {
	const secret = options.jwtSecret ?? readEnvSecret()
	if (!secret && isProduction()) {
		throw new Error(
			'createKoraAuthServer requires jwtSecret in production. Set KORA_AUTH_SECRET or pass jwtSecret.',
		)
	}

	return new TokenManager({
		secret: secret ?? TokenManager.generateSecret(),
		revocationStore: new InMemoryTokenRevocationStore(),
		...options.tokenManagerOptions,
	})
}

async function handleAuthRequest(
	routes: BuiltInAuthRoutes,
	pathPrefix: string,
	request: KoraAuthHttpRequest,
): Promise<AuthRouteResponse<unknown>> {
	const path = normalizePath(request.path)
	const relativePath = path === pathPrefix ? '/' : path.slice(pathPrefix.length)
	const method = request.method.toUpperCase()
	const body = isRecord(request.body) ? request.body : {}
	const token = extractBearerToken(request.headers)

	if (path !== pathPrefix && !path.startsWith(`${pathPrefix}/`)) {
		return notFound()
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function notFound(): AuthRouteResponse<never> {
	return { status: 404, body: { error: 'Not found' } }
}

function readEnvSecret(): string | undefined {
	return typeof process !== 'undefined' ? process.env.KORA_AUTH_SECRET : undefined
}

function isProduction(): boolean {
	return typeof process !== 'undefined' && process.env.NODE_ENV === 'production'
}
