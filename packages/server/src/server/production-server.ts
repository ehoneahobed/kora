import type { ServerStore } from '../store/server-store'
import { WsServerTransport } from '../transport/ws-server-transport'
import type { KoraSyncServerConfig } from '../types'
import { KoraSyncServer } from './kora-sync-server'

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
	 * Optional token protection for operational endpoints.
	 *
	 * When a token is omitted, the matching endpoint group remains public for
	 * backward compatibility. Production apps should set at least adminToken and
	 * backupToken.
	 */
	operationalAuth?: ProductionOperationalAuth
}

export interface ProductionOperationalAuth {
	/** Protects /__kora, /__kora/status, and /__kora/events. */
	adminToken?: string
	/** Protects /__kora/metrics. Falls back to adminToken when omitted. */
	metricsToken?: string
	/** Protects /__kora/backup/*. Falls back to adminToken when omitted. */
	backupToken?: string
}

/**
 * A production server handle returned by createProductionServer.
 */
export interface ProductionServer {
	/** Start listening. Returns the URL the server is available at. */
	start(): Promise<string>
	/** Stop the server gracefully. */
	stop(): Promise<void>
}

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.wasm': 'application/wasm',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.map': 'application/json',
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

	const syncServer = new KoraSyncServer({
		store: config.store,
		enableDashboard: true,
		...config.syncOptions,
	})

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

	function isOperationalRequestAllowed(
		req: import('node:http').IncomingMessage,
		kind: 'admin' | 'metrics' | 'backup',
	): boolean {
		const expected = getOperationalToken(kind)
		if (!expected) return true
		return extractRequestToken(req) === expected
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

	function readBodyBuffer(req: import('node:http').IncomingMessage): Promise<Buffer> {
		return new Promise((resolve) => {
			const chunks: Buffer[] = []
			req.on('data', (chunk: Buffer) => chunks.push(chunk))
			req.on('end', () => resolve(Buffer.concat(chunks)))
		})
	}

	return {
		async start(): Promise<string> {
			const { createServer } = await import('node:http')
			const { createReadStream, existsSync, statSync } = await import('node:fs')
			const { extname, join, resolve } = await import('node:path')
			const { WebSocketServer } = await import('ws')

			const distDir = resolve(staticDir)

			httpServer = createServer(async (req, res) => {
				// COOP/COEP headers required for SharedArrayBuffer (OPFS persistence)
				res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
				res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')

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
					if (!isOperationalRequestAllowed(req, 'admin')) {
						rejectUnauthorized(res)
						return
					}
					const status = await syncServer.getStatus()
					res.writeHead(200, { 'Content-Type': 'application/json' })
					res.end(JSON.stringify(status, null, 2))
					return
				}

				// ── Prometheus metrics endpoint ───────────────────────────────
				if (url.pathname === '/__kora/metrics') {
					if (!isOperationalRequestAllowed(req, 'metrics')) {
						rejectUnauthorized(res)
						return
					}
					res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' })
					res.end(formatPrometheusMetrics())
					return
				}

				// ── Server-Sent Events endpoint ───────────────────────────────
				if (url.pathname === '/__kora/events') {
					if (!isOperationalRequestAllowed(req, 'admin')) {
						rejectUnauthorized(res)
						return
					}
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
					if (!isOperationalRequestAllowed(req, 'admin')) {
						rejectUnauthorized(res)
						return
					}
					const status = await syncServer.getStatus()
					res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
					res.end(renderDashboardHtml(status))
					return
				}

				// ── Backup export ─────────────────────────────────────────────
				if (url.pathname === '/__kora/backup/export' && req.method === 'POST') {
					if (!isOperationalRequestAllowed(req, 'backup')) {
						rejectUnauthorized(res)
						return
					}
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
					if (!isOperationalRequestAllowed(req, 'backup')) {
						rejectUnauthorized(res)
						return
					}
					try {
						const body = await readBodyBuffer(req)
						const merge = url.searchParams.get('merge') === 'true'
						const result = await config.store.importBackup(
							new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
							merge,
						)
						res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' })
						res.end(JSON.stringify(result))
					} catch (error) {
						res.writeHead(500, { 'Content-Type': 'application/json' })
						res.end(JSON.stringify({ error: 'Restore failed', message: (error as Error).message }))
					}
					return
				}

				// ── Static file serving ───────────────────────────────────────
				let filePath = join(distDir, url.pathname)

				// SPA fallback: serve index.html for non-file routes
				if (!extname(filePath)) {
					const indexPath = join(filePath, 'index.html')
					if (existsSync(indexPath)) {
						filePath = indexPath
					} else {
						filePath = join(distDir, 'index.html')
					}
				}

				if (!existsSync(filePath)) {
					filePath = join(distDir, 'index.html')
				}

				try {
					const stat = statSync(filePath)
					if (stat.isDirectory()) {
						filePath = join(filePath, 'index.html')
					}
				} catch {
					filePath = join(distDir, 'index.html')
				}

				if (!existsSync(filePath)) {
					res.writeHead(404)
					res.end('Not Found')
					return
				}

				const ext = extname(filePath)
				const contentType = MIME_TYPES[ext] || 'application/octet-stream'
				res.writeHead(200, { 'Content-Type': contentType })
				createReadStream(filePath).pipe(res)
			})

			const wss = new WebSocketServer({ noServer: true })

			httpServer.on('upgrade', (req, socket, head) => {
				const url = new URL(req.url || '/', `http://${req.headers.host}`)
				if (url.pathname === syncPath) {
					wss.handleUpgrade(req, socket, head, (ws) => {
						const transport = new WsServerTransport(ws)
						syncServer.handleConnection(transport)
					})
				} else {
					socket.destroy()
				}
			})

			return new Promise<string>((resolve) => {
				httpServer?.listen(port, '0.0.0.0', () => {
					resolve(`http://localhost:${port}`)
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
