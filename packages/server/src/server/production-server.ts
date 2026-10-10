import type { BlobRef } from '@korajs/core'
import type { AccessApi } from '../access/access-api'
import { BackupValidationError } from '../apply/ingest-validation'
import type { ServerStore } from '../store/server-store'
import type { WsWebSocket } from '../transport/ws-server-transport'
import type { KoraSyncServerConfig } from '../types'
import {
	DEFAULT_MAX_MESSAGE_BYTES,
	KoraSyncServer,
	resolvePerMessageDeflate,
} from './kora-sync-server'
import type { ProductionHttpRouteContext } from './route-context'
import { type ShellMeta, applyShellMeta } from './shell-meta'
import { createStaticFileHandler } from './static-files'
import { type TrustProxySetting, resolveClientIp } from './trust-proxy'

/**
 * Configuration for the production server that serves both
 * static files and WebSocket sync on a single port.
 */
export interface ProductionServerConfig {
	/** Server-side operation store */
	store: ServerStore
	/** Port to listen on. Defaults to 3001 or process.env.PORT. */
	port?: number
	/** Directory containing built static files. Defaults to './dist'. */
	staticDir?: string
	/** WebSocket sync path. Defaults to '/kora-sync'. */
	syncPath?: string
	/** Additional KoraSyncServer options */
	syncOptions?: Omit<KoraSyncServerConfig, 'store' | 'port' | 'host' | 'path'>
	/**
	 * Cross-Origin-Embedder-Policy for static and route responses. Defaults to
	 * `credentialless`, which keeps third-party embeds usable while allowing
	 * capable browsers to enable cross-origin isolation. Use `require-corp` only
	 * when every embedded resource explicitly opts in with CORP/CORS headers.
	 */
	crossOriginEmbedderPolicy?: 'credentialless' | 'require-corp' | 'unsafe-none'
	/**
	 * Optional HTTP route handlers mounted before static file serving.
	 *
	 * This is intentionally framework-agnostic so packages such as
	 * `@korajs/auth` can plug into the production server without requiring
	 * Express, Hono, or another HTTP framework.
	 */
	httpRoutes?: ProductionHttpRoute[]
	/**
	 * Optional token protection for operational endpoints.
	 *
	 * When a token is omitted, the matching endpoint group remains public for
	 * backward compatibility. Production apps should set at least adminToken and
	 * backupToken.
	 */
	operationalAuth?: ProductionOperationalAuth
	/**
	 * Reverse proxies trusted to report the client address in `X-Forwarded-For`,
	 * which becomes `request.ip` (the key `@korajs/auth` rate-limits sign-in by).
	 * A hop count (`1` for a single load balancer in front) or a list of trusted
	 * proxy IPs / CIDR ranges. When unset, the header is ignored and `request.ip`
	 * is the socket address, so a client cannot pick its own rate-limit bucket.
	 */
	trustProxy?: TrustProxySetting
	/**
	 * Largest request body a custom HTTP route (`httpRoutes`) accepts, in bytes. A
	 * larger body is refused with 413 before it is buffered (SRV-6), so an
	 * unauthenticated client cannot make the server hold arbitrary amounts of memory.
	 * Defaults to 1 MiB.
	 */
	maxRequestBodyBytes?: number
	/**
	 * Largest backup accepted by `/__kora/backup/import`, in bytes. Defaults to 256 MiB.
	 */
	maxBackupBytes?: number
	/**
	 * Which requests for a missing path get the app shell (`index.html`). `'navigation'`
	 * (default): page requests, meaning browser navigations and non-browser clients
	 * (link-preview crawlers, search engines) asking for an extensionless path outside
	 * `/api/` and `/__kora`; an app's own `fetch()` of a missing path stays a 404.
	 * `'strict'`: browser navigations only. `'extensionless'`: also any path without a
	 * file extension, for a service worker that warms app routes with a plain
	 * `fetch(url)`. Never under `/assets/`.
	 */
	spaFallback?: 'navigation' | 'strict' | 'extensionless'
	/**
	 * Per-URL `<head>` metadata for the app shell: title, description and Open Graph
	 * tags, so a shared link previews the page it points at (crawlers do not run the
	 * app's JavaScript). Called whenever the shell is served; return null to keep the
	 * build's `index.html` as is. Values are escaped. A throw serves the unchanged shell.
	 *
	 * @example
	 * ```typescript
	 * shellMeta: async ({ path, kora }) => {
	 *   const slug = path.match(/^\/f\/([^/]+)/)?.[1]
	 *   if (!slug) return null
	 *   const [form] = await kora.query('forms', { where: { slug, status: 'published' } })
	 *   return form ? { title: form.title, description: metaExcerpt(form.description) } : null
	 * }
	 * ```
	 */
	shellMeta?: (request: ProductionShellRequest) => Promise<ShellMeta | null> | ShellMeta | null
}

/** The request the app shell is being served for (see {@link ProductionServerConfig.shellMeta}). */
export interface ProductionShellRequest {
	path: string
	query?: Record<string, string | string[] | undefined>
	headers?: Record<string, string | string[] | undefined>
	ip?: string
	/** Trusted data-plane access, as in custom routes. */
	kora: ProductionHttpRouteContext
}

/** Default largest custom-route request body: 1 MiB. */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024
/** The endpoints each operational token protects. */
const OPERATIONAL_PATHS = {
	admin: '/__kora, /__kora/status, /__kora/events',
	metrics: '/__kora/metrics',
	backup: '/__kora/backup/*',
} as const

/** Default largest backup import body: 256 MiB. */
export const DEFAULT_MAX_BACKUP_BYTES = 256 * 1024 * 1024

export interface ProductionOperationalAuth {
	/** Protects /__kora, /__kora/status, and /__kora/events. */
	adminToken?: string
	/** Protects /__kora/metrics. Falls back to adminToken when omitted. */
	metricsToken?: string
	/** Protects /__kora/backup/*. Falls back to adminToken when omitted. */
	backupToken?: string
	/**
	 * With `NODE_ENV=production`, an endpoint group whose token is unset is disabled
	 * (`403 OPERATIONAL_ENDPOINT_DISABLED`): backups export or replace every user's data,
	 * and the dashboard lists connected devices. Set this to `true` to serve such groups
	 * without a token anyway (for example behind a network you control). Outside
	 * production, groups without a token stay public, with a startup warning.
	 */
	allowPublic?: boolean
}

export interface ProductionHttpRouteRequest {
	method: string
	path: string
	body?: unknown
	headers?: Record<string, string | string[] | undefined>
	query?: Record<string, string | string[] | undefined>
	ip?: string
	/**
	 * Scoped, validated data-plane access. Use `kora.apply()` to mutate through
	 * the same pipeline as sync (constraints, referential integrity, fan-out) and
	 * `kora.query()` / `kora.findById()` to read materialized state, instead of
	 * writing to the store directly and bypassing those guarantees.
	 */
	kora: ProductionHttpRouteContext
	/**
	 * Group memberships (`grant`, `revoke`, `transfer`), for a schema with `access`
	 * rules: an "accept invitation" route grants the membership here. See
	 * `KoraSyncServer.access`.
	 */
	access: AccessApi
}

export interface ProductionHttpRouteResponse {
	status: number
	/** JSON body (the default). Ignored when `html` or `raw` is set. */
	body?: unknown
	/** An HTML document, sent as `text/html; charset=utf-8`. */
	html?: string
	/** Bytes or text sent as is; set `Content-Type` in `headers` (default `application/octet-stream`). */
	raw?: string | Uint8Array
	headers?: Record<string, string>
}

export interface ProductionHttpRoute {
	/** URL path prefix, for example `/auth`. */
	path: string
	handle(request: ProductionHttpRouteRequest): Promise<ProductionHttpRouteResponse>
}

/**
 * A production server handle returned by createProductionServer.
 */
export interface ProductionServer {
	/**
	 * Start listening. Returns the URL the server is available at, with the port it
	 * actually bound (pass `port: 0` to let the OS pick a free one).
	 */
	start(): Promise<string>
	/** Stop the server gracefully. */
	stop(): Promise<void>
	/**
	 * Trusted, scoped data-plane access for server-side callers that have no HTTP
	 * request — background jobs, scheduled tasks, seeding scripts.
	 *
	 * `kora.apply()` runs the mutation through the exact same validated pipeline as
	 * sync (Tier 2 constraints, referential integrity, materialization, and fan-out
	 * to connected clients), and `kora.query()` / `kora.findById()` read
	 * materialized state. This is the same context handed to custom HTTP routes as
	 * `request.kora`, so a job and a request share one code path and one set of
	 * guarantees instead of the job writing to the store directly and silently
	 * bypassing validation.
	 */
	kora: ProductionHttpRouteContext
	/**
	 * Group memberships for a schema with `access` rules: `grant`, `revoke`, `transfer`
	 * and `sweepExpired` (see `KoraSyncServer.access`). For background jobs and scripts;
	 * custom routes get the same object as `request.access`.
	 */
	access: AccessApi
	/**
	 * Every blob reference still reachable from a live record across all
	 * collections that declare a `blob` field. This is the live set for
	 * garbage-collecting the server's central blob store: pass it to
	 * `collectBlobGarbage(blobStore, refs)` from `@korajs/store` on a schedule to
	 * reclaim bytes no record points at any more.
	 *
	 * @returns Every live blob reference the server can currently see.
	 */
	getLiveBlobRefs(): Promise<BlobRef[]>
	/**
	 * Re-resolve one user's grant on their live sync sessions now. Call it after a
	 * membership change (an invitation accepted, a collaborator removed): a session
	 * whose scope changed ends with a retriable `SCOPE_CHANGED` and its client
	 * reconnects with the new grant, applying its `scopeExit` policy. See
	 * `KoraSyncServer.refreshScopes`.
	 *
	 * @param userId - The user whose grant changed
	 * @returns The number of sessions ended
	 */
	refreshScopes(userId: string): Promise<number>
	/**
	 * Re-validate every live sync session's credential and grant now (the pass that
	 * otherwise runs every `sessionRevalidationIntervalMs`). See
	 * `KoraSyncServer.revalidateSessions`.
	 *
	 * @returns The number of sessions ended
	 */
	revalidateSessions(): Promise<number>
}

/**
 * Creates a production server that serves both static files and WebSocket sync
 * on a single port, plus built-in dashboard and observability endpoints.
 *
 * @param config - Production server configuration
 * @returns A ProductionServer instance
 *
 * @example
 * ```typescript
 * const server = createProductionServer({
 *   store: createSqliteServerStore({ filename: './kora-server.db' }),
 * })
 * const url = await server.start()
 * ```
 */
export function createProductionServer(config: ProductionServerConfig): ProductionServer {
	const port = config.port ?? (Number(process.env.PORT) || 3001)
	const staticDir = config.staticDir ?? './dist'
	const syncPath = config.syncPath ?? '/kora-sync'
	const crossOriginEmbedderPolicy = config.crossOriginEmbedderPolicy ?? 'credentialless'

	const syncServer = new KoraSyncServer({
		store: config.store,
		enableDashboard: true,
		...config.syncOptions,
	})

	// Scoped, validated data-plane access handed to every custom HTTP route as
	// `request.kora`, exposed on the handle as `server.kora`, and used by the
	// operation validator. One shared context (it holds no per-request state).
	const routeContext = syncServer.getKoraContext()

	let httpServer: import('node:http').Server | null = null

	function getOperationalToken(kind: 'admin' | 'metrics' | 'backup'): string | undefined {
		const auth = config.operationalAuth
		if (!auth) return undefined
		if (kind === 'metrics') return auth.metricsToken || auth.adminToken
		if (kind === 'backup') return auth.backupToken || auth.adminToken
		return auth.adminToken
	}

	function extractRequestToken(req: import('node:http').IncomingMessage): string | null {
		const authorization = req.headers.authorization
		if (authorization?.startsWith('Bearer ')) {
			return authorization.slice('Bearer '.length).trim()
		}

		const headerNames = ['x-kora-admin-token', 'x-kora-metrics-token', 'x-kora-backup-token']
		for (const name of headerNames) {
			const value = req.headers[name]
			if (typeof value === 'string' && value.length > 0) return value
			if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) {
				return value[0]
			}
		}

		return null
	}

	// Decided once, at creation: an operational group without a token is disabled in
	// production unless the app opted in (F5).
	const production = process.env.NODE_ENV === 'production'
	const allowPublic = config.operationalAuth?.allowPublic === true
	const OPERATIONAL_GROUPS = ['admin', 'metrics', 'backup'] as const
	const unprotectedGroups = OPERATIONAL_GROUPS.filter((kind) => !getOperationalToken(kind))

	function isOperationalRequestAllowed(
		req: import('node:http').IncomingMessage,
		res: import('node:http').ServerResponse,
		kind: 'admin' | 'metrics' | 'backup',
	): boolean {
		const expected = getOperationalToken(kind)
		if (!expected) {
			if (!production || allowPublic) return true
			res.writeHead(403, { 'Content-Type': 'application/json' })
			res.end(
				JSON.stringify({
					error: `This operational endpoint is disabled: no ${kind === 'admin' ? 'adminToken' : `${kind}Token or adminToken`} is configured and NODE_ENV is production.`,
					code: 'OPERATIONAL_ENDPOINT_DISABLED',
					fix: 'Set operationalAuth tokens in createProductionServer, or operationalAuth.allowPublic: true to serve it without one.',
				}),
			)
			return false
		}
		if (extractRequestToken(req) === expected) return true
		rejectUnauthorized(res)
		return false
	}

	function rejectUnauthorized(res: import('node:http').ServerResponse): void {
		res.writeHead(401, {
			'Content-Type': 'application/json',
			'WWW-Authenticate': 'Bearer realm="kora"',
		})
		res.end(JSON.stringify({ error: 'Unauthorized' }))
	}

	/**
	 * Format the metrics snapshot as Prometheus exposition format.
	 * Zero-dependency — no prom-client needed.
	 */
	function formatPrometheusMetrics(): string {
		const status = syncServer.getMetricsCollector().getSnapshot(0)
		const lines: string[] = [
			'# HELP kora_connected_clients Current number of connected clients',
			'# TYPE kora_connected_clients gauge',
			`kora_connected_clients ${status.connectedClients}`,
			'',
			'# HELP kora_peak_connections Peak number of simultaneous connections since server start',
			'# TYPE kora_peak_connections gauge',
			`kora_peak_connections ${status.peakConnections}`,
			'',
			'# HELP kora_connections_total Total number of connections handled since server start',
			'# TYPE kora_connections_total counter',
			`kora_connections_total ${status.connectionsTotal}`,
			'',
			'# HELP kora_operations_received_total Total operations received from clients',
			'# TYPE kora_operations_received_total counter',
			`kora_operations_received_total ${status.operationsReceived}`,
			'',
			'# HELP kora_operation_batches_received_total Total operation batches received from clients',
			'# TYPE kora_operation_batches_received_total counter',
			`kora_operation_batches_received_total ${status.batchesReceived}`,
			'',
			'# HELP kora_unique_operations_received_total Newly materialized operations received from clients',
			'# TYPE kora_unique_operations_received_total counter',
			`kora_unique_operations_received_total ${status.uniqueOperationsReceived}`,
			'',
			'# HELP kora_duplicate_operations_received_total Duplicate operations received from clients',
			'# TYPE kora_duplicate_operations_received_total counter',
			`kora_duplicate_operations_received_total ${status.duplicateOperationsReceived}`,
			'',
			'# HELP kora_rejected_operations_total Operations rejected before authoritative materialization',
			'# TYPE kora_rejected_operations_total counter',
			`kora_rejected_operations_total ${status.rejectedOperations}`,
			'',
			'# HELP kora_operations_sent_total Total operations sent to clients',
			'# TYPE kora_operations_sent_total counter',
			`kora_operations_sent_total ${status.operationsSent}`,
			'',
			'# HELP kora_bytes_received_total Total bytes received from clients',
			'# TYPE kora_bytes_received_total counter',
			`kora_bytes_received_total ${status.bytesReceived}`,
			'',
			'# HELP kora_bytes_sent_total Total bytes sent to clients',
			'# TYPE kora_bytes_sent_total counter',
			`kora_bytes_sent_total ${status.bytesSent}`,
			'',
			'# HELP kora_errors_total Total errors since server start',
			'# TYPE kora_errors_total counter',
			`kora_errors_total ${status.errorCount}`,
			'',
			'# HELP kora_uptime_seconds Server uptime in seconds',
			'# TYPE kora_uptime_seconds gauge',
			`kora_uptime_seconds ${Math.floor(status.uptime / 1000)}`,
			'',
			'# HELP kora_schema_version Schema version the server expects',
			'# TYPE kora_schema_version gauge',
			`kora_schema_version ${status.schemaVersion}`,
			'',
		]
		return lines.join('\n')
	}

	const maxRequestBodyBytes = config.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
	const maxBackupBytes = config.maxBackupBytes ?? DEFAULT_MAX_BACKUP_BYTES

	/**
	 * Read a request body of at most `limit` bytes. Resolves null when the body (or its
	 * declared Content-Length) is larger: the caller answers 413, and nothing past the
	 * limit is buffered (SRV-6).
	 */
	function readBodyBuffer(
		req: import('node:http').IncomingMessage,
		limit: number,
	): Promise<Buffer | null> {
		const declared = Number(req.headers['content-length'])
		if (Number.isFinite(declared) && declared > limit) return Promise.resolve(null)
		return new Promise((resolve) => {
			const chunks: Buffer[] = []
			let received = 0
			let settled = false
			const finish = (value: Buffer | null): void => {
				if (settled) return
				settled = true
				resolve(value)
			}
			req.on('data', (chunk: Buffer) => {
				if (settled) return
				received += chunk.byteLength
				if (received > limit) {
					chunks.length = 0
					// Stop reading; the caller replies 413 and then drops the connection.
					req.pause()
					finish(null)
					return
				}
				chunks.push(chunk)
			})
			req.on('end', () => finish(Buffer.concat(chunks)))
			// A raw http.IncomingMessage starts paused: attaching 'data'/'end'
			// listeners alone does not put it in flowing mode. Without an
			// explicit resume(), 'data' never fires, 'end' fires immediately with
			// zero chunks, and every POST body silently reads back as empty —
			// which is exactly what broke httpRoutes handlers (including
			// @korajs/auth's signup/signin) reading `req.body`. Guard with
			// `readableFlowing` so this stays a no-op if the stream is already
			// flowing (e.g. a future caller that reads it differently).
			if (!req.readableFlowing) {
				req.resume()
			}
			// If the client disconnects mid-upload, `end` never fires; resolve
			// with whatever arrived instead of leaving the request hung forever.
			req.on('error', () => finish(Buffer.concat(chunks)))
		})
	}

	/** Answer 413 and drop the connection once the response is written. */
	function rejectTooLarge(
		req: import('node:http').IncomingMessage,
		res: import('node:http').ServerResponse,
		limit: number,
	): void {
		res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' })
		res.end(JSON.stringify({ error: 'Payload too large', maxBytes: limit }), () => req.destroy())
	}

	async function readJsonBody(
		req: import('node:http').IncomingMessage,
	): Promise<{ tooLarge: true } | { tooLarge: false; body: unknown }> {
		const buffer = await readBodyBuffer(req, maxRequestBodyBytes)
		if (buffer === null) return { tooLarge: true }
		if (buffer.byteLength === 0) return { tooLarge: false, body: undefined }
		try {
			return { tooLarge: false, body: JSON.parse(buffer.toString('utf8')) as unknown }
		} catch {
			return { tooLarge: false, body: undefined }
		}
	}

	function matchesRoutePrefix(pathname: string, prefix: string): boolean {
		const normalizedPrefix = normalizeRoutePath(prefix)
		return pathname === normalizedPrefix || pathname.startsWith(`${normalizedPrefix}/`)
	}

	function normalizeRoutePath(path: string): string {
		const prefixed = path.startsWith('/') ? path : `/${path}`
		return prefixed.length > 1 ? prefixed.replace(/\/+$/, '') : prefixed
	}

	function getClientIp(req: import('node:http').IncomingMessage): string | undefined {
		return resolveClientIp(
			req.socket.remoteAddress,
			req.headers['x-forwarded-for'],
			config.trustProxy,
		)
	}

	function getQuery(url: URL): Record<string, string | string[] | undefined> {
		const query: Record<string, string | string[] | undefined> = {}
		for (const [key, value] of url.searchParams) {
			const existing = query[key]
			if (existing === undefined) {
				query[key] = value
			} else if (Array.isArray(existing)) {
				existing.push(value)
			} else {
				query[key] = [existing, value]
			}
		}
		return query
	}

	function writeJsonResponse(
		res: import('node:http').ServerResponse,
		result: ProductionHttpRouteResponse,
	): void {
		if (result.raw !== undefined) {
			res.writeHead(result.status, {
				'Content-Type': 'application/octet-stream',
				...(result.headers ?? {}),
			})
			res.end(result.raw)
			return
		}
		if (result.html !== undefined) {
			res.writeHead(result.status, {
				'Content-Type': 'text/html; charset=utf-8',
				...(result.headers ?? {}),
			})
			res.end(result.html)
			return
		}
		const headers = {
			'Content-Type': 'application/json',
			...(result.headers ?? {}),
		}
		res.writeHead(result.status, headers)
		res.end(JSON.stringify(result.body ?? null))
	}

	return {
		kora: routeContext,
		access: syncServer.access,

		getLiveBlobRefs(): Promise<BlobRef[]> {
			return syncServer.getLiveBlobRefs()
		},

		refreshScopes(userId: string): Promise<number> {
			return syncServer.refreshScopes(userId)
		},

		revalidateSessions(): Promise<number> {
			return syncServer.revalidateSessions()
		},

		async start(): Promise<string> {
			if (unprotectedGroups.length > 0) {
				const paths = unprotectedGroups.map((kind) => OPERATIONAL_PATHS[kind]).join(', ')
				syncServer.getLogger().log({
					timestamp: Date.now(),
					level: 'warn',
					event: 'server.operational_endpoints_unprotected',
					details: {
						groups: unprotectedGroups,
						disabled: production && !allowPublic,
						message:
							production && !allowPublic
								? `Operational endpoints without a token are disabled (${paths}). Set operationalAuth.adminToken and backupToken to use them.`
								: `Operational endpoints without a token are PUBLIC (${paths}). Set operationalAuth.adminToken and backupToken before exposing this server.`,
					},
				})
			}
			const { createServer } = await import('node:http')
			const { WebSocketServer } = await import('ws')

			const shellMeta = config.shellMeta
			const serveStatic = createStaticFileHandler(staticDir, {
				...(config.spaFallback ? { spaFallback: config.spaFallback } : {}),
				...(shellMeta
					? {
							transformShell: async (req, pathname, html) => {
								const url = new URL(req.url || '/', 'http://localhost')
								const meta = await shellMeta({
									path: pathname,
									query: getQuery(url),
									headers: req.headers,
									ip: getClientIp(req),
									kora: routeContext,
								})
								return meta ? applyShellMeta(html, meta) : null
							},
						}
					: {}),
			})

			httpServer = createServer(async (req, res) => {
				try {
					await handleRequest(req, res)
				} catch (error) {
					// http.createServer never awaits its request listener, so a
					// callback that rejects becomes an unhandled promise rejection
					// process-wide, and Node's default `--unhandled-rejections=throw`
					// crashes the entire server. One bad request (malformed body,
					// a buggy custom httpRoute handler, anything unexpected) must
					// only fail that one response, never take the whole process
					// down with it.
					console.error('[kora] Unhandled error in HTTP request handler:', error)
					if (!res.headersSent) {
						res.writeHead(500, { 'Content-Type': 'application/json' })
						res.end(JSON.stringify({ error: 'Internal server error' }))
					} else if (!res.writableEnded) {
						res.end()
					}
				}
			})

			async function handleRequest(
				req: import('node:http').IncomingMessage,
				res: import('node:http').ServerResponse,
			): Promise<void> {
				// COOP/COEP headers required for SharedArrayBuffer (OPFS persistence)
				res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
				res.setHeader('Cross-Origin-Embedder-Policy', crossOriginEmbedderPolicy)

				const url = new URL(req.url || '/', `http://${req.headers.host}`)

				// ── Health check ──────────────────────────────────────────────
				if (url.pathname === '/health') {
					const status = await syncServer.getStatus()
					res.writeHead(200, { 'Content-Type': 'application/json' })
					res.end(
						JSON.stringify({
							status: 'ok',
							version: status.version,
							uptime: status.uptime,
							connectedClients: status.connectedClients,
							totalOperations: status.totalOperations,
							timestamp: Date.now(),
						}),
					)
					return
				}

				// ── Status endpoint ───────────────────────────────────────────
				if (url.pathname === '/__kora/status') {
					if (!isOperationalRequestAllowed(req, res, 'admin')) return
					const status = await syncServer.getStatus()
					res.writeHead(200, { 'Content-Type': 'application/json' })
					res.end(JSON.stringify(status, null, 2))
					return
				}

				// ── Prometheus metrics endpoint ───────────────────────────────
				if (url.pathname === '/__kora/metrics') {
					if (!isOperationalRequestAllowed(req, res, 'metrics')) return
					res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' })
					res.end(formatPrometheusMetrics())
					return
				}

				// ── Server-Sent Events endpoint ───────────────────────────────
				if (url.pathname === '/__kora/events') {
					if (!isOperationalRequestAllowed(req, res, 'admin')) return
					res.writeHead(200, {
						'Content-Type': 'text/event-stream',
						'Cache-Control': 'no-cache',
						Connection: 'keep-alive',
						'X-Accel-Buffering': 'no',
					})

					// Send initial status event
					const status = await syncServer.getStatus()
					res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`)

					// Poll metrics periodically and push as SSE events
					const interval = setInterval(async () => {
						try {
							const s = await syncServer.getStatus()
							res.write(`event: status\ndata: ${JSON.stringify(s)}\n\n`)
						} catch {
							// Connection may have closed
						}
					}, 2000)

					// Clean up on connection close
					req.on('close', () => {
						clearInterval(interval)
					})

					return
				}

				// ── Dashboard HTML ────────────────────────────────────────────
				if (url.pathname === '/__kora' || url.pathname === '/__kora/') {
					if (!isOperationalRequestAllowed(req, res, 'admin')) return
					const status = await syncServer.getStatus()
					res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
					res.end(renderDashboardHtml(status))
					return
				}

				// ── Backup export ─────────────────────────────────────────────
				if (url.pathname === '/__kora/backup/export' && req.method === 'POST') {
					if (!isOperationalRequestAllowed(req, res, 'backup')) return
					try {
						const backup = await config.store.exportBackup()
						res.writeHead(200, {
							'Content-Type': 'application/octet-stream',
							'Content-Disposition': `attachment; filename="kora-backup-${Date.now()}.kora"`,
							'Content-Length': String(backup.byteLength),
						})
						res.end(Buffer.from(backup))
					} catch (error) {
						res.writeHead(500, { 'Content-Type': 'application/json' })
						res.end(JSON.stringify({ error: 'Backup failed', message: (error as Error).message }))
					}
					return
				}

				// ── Backup import ─────────────────────────────────────────────
				if (url.pathname === '/__kora/backup/import' && req.method === 'POST') {
					if (!isOperationalRequestAllowed(req, res, 'backup')) return
					try {
						const body = await readBodyBuffer(req, maxBackupBytes)
						if (body === null) {
							rejectTooLarge(req, res, maxBackupBytes)
							return
						}
						const merge = url.searchParams.get('merge') === 'true'
						const result = await config.store.importBackup(
							new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
							merge,
						)
						res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' })
						res.end(JSON.stringify(result))
					} catch (error) {
						// A backup whose operations fail ingest validation (far-future
						// timestamps, malformed sequence numbers) is the caller's input, not a
						// server fault: 400 with the details (SYNC-7).
						const invalid = error instanceof BackupValidationError
						res.writeHead(invalid ? 400 : 500, { 'Content-Type': 'application/json' })
						res.end(
							JSON.stringify({
								error: 'Restore failed',
								message: (error as Error).message,
								...(invalid ? { code: error.code, details: error.context } : {}),
							}),
						)
					}
					return
				}

				// ── Custom HTTP routes (auth, webhooks, app APIs) ─────────────
				const customRoute = config.httpRoutes?.find((route) =>
					matchesRoutePrefix(url.pathname, route.path),
				)
				if (customRoute) {
					const parsed = await readJsonBody(req)
					if (parsed.tooLarge) {
						rejectTooLarge(req, res, maxRequestBodyBytes)
						return
					}
					const result = await customRoute.handle({
						method: req.method ?? 'GET',
						path: url.pathname,
						body: parsed.body,
						headers: req.headers,
						query: getQuery(url),
						ip: getClientIp(req),
						kora: routeContext,
						access: syncServer.access,
					})
					writeJsonResponse(res, result)
					return
				}

				// ── Static file serving (NEW-SRV-8) ───────────────────────────
				await serveStatic(req, res, url.pathname)
			}

			const wss = new WebSocketServer({
				noServer: true,
				maxPayload: config.syncOptions?.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
				perMessageDeflate: resolvePerMessageDeflate(config.syncOptions?.perMessageDeflate),
			})

			httpServer.on('upgrade', (req, socket, head) => {
				const url = new URL(req.url || '/', `http://${req.headers.host}`)
				if (url.pathname === syncPath) {
					wss.handleUpgrade(req, socket, head, (ws) => {
						// The sync server builds the transport, so this path gets the same
						// liveness probing, send-buffer ceiling and serializer as standalone.
						try {
							syncServer.handleWebSocket(ws as unknown as WsWebSocket)
						} catch {
							// Refused (for example the connection limit): handleConnection has
							// already told the client and closed the socket.
						}
					})
				} else {
					socket.destroy()
				}
			})

			return new Promise<string>((resolve, reject) => {
				const onError = (error: Error) => {
					reject(error)
				}
				httpServer?.once('error', onError)
				httpServer?.listen(port, '0.0.0.0', () => {
					httpServer?.off('error', onError)
					// Report the bound port, so `port: 0` (an OS-assigned free port, as tests
					// running in parallel use) resolves to a reachable URL.
					const address = httpServer?.address()
					const bound = address && typeof address === 'object' ? address.port : port
					resolve(`http://localhost:${bound}`)
				})
			})
		},

		async stop(): Promise<void> {
			await syncServer.stop()
			if (httpServer) {
				await new Promise<void>((resolve) => {
					httpServer?.close(() => resolve())
				})
				httpServer = null
			}
		},
	}
}

/**
 * Render a minimal self-contained dashboard HTML page.
 * Shows server status with live-updating metrics via SSE.
 */
function renderDashboardHtml(status: {
	version: string
	uptime: number
	connectedClients: number
	totalOperations: number
	schemaVersion: number
	peakConnections: number
	connectionsTotal: number
	operationsReceived: number
	operationsSent: number
	errorCount: number
}): string {
	const version = status.version
	const uptime = formatUptime(status.uptime)
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kora Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0 }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem }
  h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.25rem }
  .subtitle { color: #64748b; margin-bottom: 2rem; font-size: 0.875rem }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 0.75rem; padding: 1.25rem }
  .card .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 0.5rem }
  .card .value { font-size: 1.75rem; font-weight: 700; color: #38bdf8 }
  .card .value.green { color: #4ade80 }
  .card .value.red { color: #f87171 }
  .card .value.yellow { color: #fbbf24 }
  .section-title { font-size: 1rem; font-weight: 600; margin-bottom: 0.75rem; margin-top: 1.5rem }
  table { width: 100%; border-collapse: collapse; font-size: 0.875rem }
  th { text-align: left; padding: 0.5rem 0.75rem; color: #64748b; font-weight: 500; border-bottom: 1px solid #334155 }
  td { padding: 0.5rem 0.75rem; border-bottom: 1px solid #1e293b }
  .status-dot { display: inline-block; width: 0.5rem; height: 0.5rem; border-radius: 50%; margin-right: 0.375rem }
  .status-dot.running { background: #4ade80 }
  .status-dot.stopped { background: #f87171 }
</style>
</head>
<body>
<h1>Kora Sync Server</h1>
<p class="subtitle">v${version} &middot; <span class="status-dot running"></span>Running</p>
<div class="grid">
  <div class="card"><div class="label">Uptime</div><div class="value">${uptime}</div></div>
  <div class="card"><div class="label">Connected Clients</div><div class="value" id="connectedClients">${status.connectedClients}</div></div>
  <div class="card"><div class="label">Total Operations</div><div class="value" id="totalOperations">${status.totalOperations}</div></div>
  <div class="card"><div class="label">Peak Connections</div><div class="value green" id="peakConnections">${status.peakConnections}</div></div>
  <div class="card"><div class="label">Ops Received</div><div class="value" id="opsReceived">${status.operationsReceived}</div></div>
  <div class="card"><div class="label">Ops Sent</div><div class="value" id="opsSent">${status.operationsSent}</div></div>
  <div class="card"><div class="label">Errors</div><div class="value ${status.errorCount > 0 ? 'red' : 'green'}" id="errors">${status.errorCount}</div></div>
  <div class="card"><div class="label">Schema Version</div><div class="value">${status.schemaVersion}</div></div>
</div>
<script>
(function() {
  const es = new EventSource('/__kora/events');
  es.addEventListener('status', (e) => {
    const s = JSON.parse(e.data);
    for (const [id, val] of Object.entries({
      connectedClients: s.connectedClients,
      totalOperations: s.totalOperations,
      peakConnections: s.peakConnections,
      opsReceived: s.operationsReceived,
      opsSent: s.operationsSent,
      errors: s.errorCount,
    })) {
      const el = document.getElementById(id);
      if (el) { el.textContent = String(val); el.className = 'value' + (id === 'errors' && val > 0 ? ' red' : id === 'errors' ? ' green' : ''); }
    }
  });
  es.onerror = () => { setTimeout(() => document.location.reload(), 5000); };
})();
</script>
</body>
</html>`
}

function formatUptime(ms: number): string {
	const seconds = Math.floor(ms / 1000)
	const minutes = Math.floor(seconds / 60)
	const hours = Math.floor(minutes / 60)
	const parts: string[] = []
	if (hours > 0) parts.push(`${hours}h`)
	if (minutes % 60 > 0) parts.push(`${minutes % 60}m`)
	parts.push(`${seconds % 60}s`)
	return parts.join(' ')
}
