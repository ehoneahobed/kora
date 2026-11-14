/**
 * Which other origins may call the production server's HTTP routes from a browser engine.
 *
 * A desktop or mobile app built with Tauri loads its pages from its own scheme
 * (`tauri://localhost` on macOS and Linux, `http(s)://tauri.localhost` on Windows and Android), so
 * every call it makes to its sync server's HTTP routes (sign-in, session refresh, app APIs) is
 * cross-origin, and the webview refuses the response unless the server allows that origin. The
 * same holds in development, where the app's dev server and the sync server listen on different
 * ports. Responses never allow credentials: Kora Auth sends bearer tokens, not cookies, so
 * allowing an origin lets its pages read responses to requests they could already send.
 */

/** Page origins of native app shells. No website can serve a page from these. */
export const NATIVE_APP_ORIGINS: readonly string[] = [
	'tauri://localhost',
	'http://tauri.localhost',
	'https://tauri.localhost',
]

const LOCAL_DEVELOPMENT_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

/** Decides whether a request's `Origin` may read a route's response. */
export interface OriginPolicy {
	/** Whether pages from this origin may call the server's HTTP routes. */
	allows(origin: string | undefined): origin is string
}

/**
 * The server's origin policy: native app shells, the origins the app passes, the comma-separated
 * `KORA_ALLOWED_ORIGINS` the host sets, and, outside production, local development servers.
 */
export function createOriginPolicy(
	configured: readonly string[] | undefined,
	env: Record<string, string | undefined> = process.env,
): OriginPolicy {
	const fromEnv = (env.KORA_ALLOWED_ORIGINS ?? '')
		.split(',')
		.map((origin) => origin.trim())
		.filter((origin) => origin.length > 0)
	const allowed = new Set(
		[...NATIVE_APP_ORIGINS, ...(configured ?? []), ...fromEnv].map(normalizeOrigin),
	)
	const development = env.NODE_ENV !== 'production'
	return {
		allows(origin: string | undefined): origin is string {
			if (!origin || origin === 'null') return false
			const normalized = normalizeOrigin(origin)
			if (allowed.has(normalized)) return true
			return development && LOCAL_DEVELOPMENT_ORIGIN.test(normalized)
		},
	}
}

/** Headers that let an allowed origin read a response. */
export function corsResponseHeaders(origin: string): Record<string, string> {
	return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
}

/** Headers answering an allowed origin's preflight. */
export function corsPreflightHeaders(
	origin: string,
	requestedHeaders: string | undefined,
): Record<string, string> {
	return {
		...corsResponseHeaders(origin),
		'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
		'Access-Control-Allow-Headers':
			sanitizeHeaderList(requestedHeaders) || 'authorization, content-type',
		'Access-Control-Max-Age': '600',
	}
}

function normalizeOrigin(origin: string): string {
	return origin.trim().replace(/\/+$/, '').toLowerCase()
}

/** Echoes a preflight's requested header names, keeping only valid header tokens. */
function sanitizeHeaderList(value: string | undefined): string {
	if (!value) return ''
	return value
		.split(',')
		.map((name) => name.trim().toLowerCase())
		.filter((name) => /^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name))
		.join(', ')
}
