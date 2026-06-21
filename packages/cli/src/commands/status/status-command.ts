import { defineCommand } from 'citty'
import { createLogger } from '../../utils/logger'

const DEFAULT_SYNC_PORT = 3001
const STATUS_ENDPOINT = '/__kora/status'

interface ServerStatusResponse {
	running: boolean
	connectedClients: number
	port: number | null
	totalOperations: number
	uptime: number
	version: string
	schemaVersion: number
	connectedNodeIds: string[]
	peakConnections: number
	connectionsTotal: number
	operationsReceived: number
	operationsSent: number
	errorCount: number
}

/**
 * Fetch server status from a Kora sync server.
 */
async function fetchServerStatus(url: string, token?: string): Promise<ServerStatusResponse> {
	const statusUrl = `${url.replace(/\/$/, '')}${STATUS_ENDPOINT}`
	const response = await fetch(statusUrl, {
		headers: token ? { Authorization: `Bearer ${token}` } : undefined,
	})
	if (!response.ok) {
		throw new Error(
			`Failed to fetch status from ${statusUrl}: ${response.status} ${response.statusText}`,
		)
	}

	return (await response.json()) as ServerStatusResponse
}

function formatUptime(ms: number): string {
	const seconds = Math.floor(ms / 1000)
	const minutes = Math.floor(seconds / 60)
	const hours = Math.floor(minutes / 60)
	const days = Math.floor(hours / 24)
	const parts: string[] = []
	if (days > 0) parts.push(`${days}d`)
	if (hours % 24 > 0) parts.push(`${hours % 24}h`)
	if (minutes % 60 > 0) parts.push(`${minutes % 60}m`)
	parts.push(`${seconds % 60}s`)
	return parts.join(' ')
}

/**
 * The `status` command — shows the current status of a Kora sync server.
 */
export const statusCommand = defineCommand({
	meta: {
		name: 'status',
		description: 'Show Kora sync server status',
	},
	args: {
		url: {
			type: 'string',
			description: 'Sync server URL (default: http://localhost:3001)',
			default: `http://localhost:${DEFAULT_SYNC_PORT}`,
		},
		watch: {
			type: 'boolean',
			description: 'Live-updating status (like htop)',
			default: false,
			alias: 'w',
		},
		token: {
			type: 'string',
			description: 'Admin token (defaults to KORA_ADMIN_TOKEN)',
		},
	},
	async run({ args }) {
		const logger = createLogger()
		const url = typeof args.url === 'string' ? args.url : `http://localhost:${DEFAULT_SYNC_PORT}`
		const watch = args.watch === true
		const token =
			typeof args.token === 'string' ? args.token : (process.env.KORA_ADMIN_TOKEN ?? undefined)

		try {
			if (watch) {
				// Live-updating mode
				console.clear()
				logger.banner()
				logger.info(`Connecting to ${url}...`)

				const interval = setInterval(async () => {
					try {
						const status = await fetchServerStatus(url, token)
						printStatus(status, url, logger)
					} catch {
						// Clear the previous status output
						// On next iteration, we'll try again
					}
				}, 2000)

				// Initial fetch
				try {
					const status = await fetchServerStatus(url, token)
					printStatus(status, url, logger)
				} catch {
					// Will retry on interval
				}

				// Keep running until Ctrl+C
				await new Promise(() => {
					process.on('SIGINT', () => {
						clearInterval(interval)
						process.exit(0)
					})
					process.on('SIGTERM', () => {
						clearInterval(interval)
						process.exit(0)
					})
				})
			} else {
				const status = await fetchServerStatus(url, token)
				printStatus(status, url, logger)
			}
		} catch (error) {
			logger.error(`Failed to connect to ${url}`)
			if (error instanceof Error) {
				logger.error(error.message)
			}
			logger.blank()
			logger.step('Make sure the Kora sync server is running.')
			logger.step('Start it with: kora dev')
			process.exit(1)
		}
	},
})

function printStatus(
	status: ServerStatusResponse,
	url: string,
	logger: ReturnType<typeof createLogger>,
): void {
	console.clear()
	logger.banner()
	logger.info(`Kora Sync Server — ${url}`)
	logger.blank()

	if (!status.running) {
		logger.error('Server is not running')
		return
	}

	// Server info
	logger.step(`Status:     Running (uptime: ${formatUptime(status.uptime)}) — v${status.version}`)
	logger.step(`Schema:     v${status.schemaVersion}`)
	logger.blank()

	// Connections
	logger.step(`Connections: ${status.connectedClients} connected`)
	logger.step(`  Peak:      ${status.peakConnections}`)
	logger.step(`  Total:     ${status.connectionsTotal}`)

	if (status.connectedNodeIds.length > 0) {
		logger.step('  Active nodes:')
		for (const nodeId of status.connectedNodeIds) {
			logger.step(`    • ${nodeId}`)
		}
	}
	logger.blank()

	// Operations
	logger.step('Operations:')
	logger.step(`  Received:  ${status.operationsReceived.toLocaleString()}`)
	logger.step(`  Sent:      ${status.operationsSent.toLocaleString()}`)
	logger.step(`  Total:     ${status.totalOperations.toLocaleString()}`)
	logger.blank()

	// Errors
	if (status.errorCount > 0) {
		logger.warn(`Errors: ${status.errorCount}`)
	} else {
		logger.step('Errors:     0')
	}
}
