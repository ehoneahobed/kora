import type { ServerStore } from '../store/server-store'
import type { KoraSyncServerConfig } from '../types'
import { KoraSyncServer } from './kora-sync-server'
import { WsServerTransport } from '../transport/ws-server-transport'

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
 * on a single port. This is the recommended way to deploy a Kora app — one port
 * means one tunnel (ngrok, cloudflared) handles everything.
 *
 * @param config - Production server configuration
 * @returns A ProductionServer instance
 *
 * @example
 * ```typescript
 * import { createProductionServer, createSqliteServerStore } from '@korajs/server'
 *
 * const server = createProductionServer({
 *   store: createSqliteServerStore({ filename: './kora-server.db' }),
 * })
 *
 * const url = await server.start()
 * console.log(`App running at ${url}`)
 * ```
 */
export function createProductionServer(config: ProductionServerConfig): ProductionServer {
	const port = config.port ?? (Number(process.env.PORT) || 3001)
	const staticDir = config.staticDir ?? './dist'
	const syncPath = config.syncPath ?? '/kora-sync'

	const syncServer = new KoraSyncServer({
		store: config.store,
		...config.syncOptions,
	})

	let httpServer: import('node:http').Server | null = null

	return {
		async start(): Promise<string> {
			const { createServer } = await import('node:http')
			const { createReadStream, existsSync, statSync } = await import('node:fs')
			const { extname, join, resolve } = await import('node:path')
			const { WebSocketServer } = await import('ws')

			const distDir = resolve(staticDir)

			httpServer = createServer((req, res) => {
				// COOP/COEP headers required for SharedArrayBuffer (OPFS persistence)
				res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
				res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')

				const url = new URL(req.url || '/', `http://${req.headers.host}`)
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
				httpServer!.listen(port, '0.0.0.0', () => {
					resolve(`http://localhost:${port}`)
				})
			})
		},

		async stop(): Promise<void> {
			await syncServer.stop()
			if (httpServer) {
				await new Promise<void>((resolve) => {
					httpServer!.close(() => resolve())
				})
				httpServer = null
			}
		},
	}
}
