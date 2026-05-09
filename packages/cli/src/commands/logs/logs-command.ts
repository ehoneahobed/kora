import { defineCommand } from 'citty'
import { createLogger } from '../../utils/logger'

const DEFAULT_SYNC_PORT = 3001
const EVENTS_ENDPOINT = '/__kora/events'

/**
 * The `logs` command — streams real-time events from a Kora sync server.
 */
export const logsCommand = defineCommand({
	meta: {
		name: 'logs',
		description: 'Stream real-time events from a Kora sync server',
	},
	args: {
		url: {
			type: 'string',
			description: 'Sync server URL (default: http://localhost:3001)',
			default: `http://localhost:${DEFAULT_SYNC_PORT}`,
		},
		follow: {
			type: 'boolean',
			description: 'Follow log output (like tail -f)',
			default: true,
			alias: 'f',
		},
		level: {
			type: 'string',
			description: 'Filter by log level (info, warn, error)',
		},
	},
	async run({ args }) {
		const logger = createLogger()
		const url = typeof args.url === 'string' ? args.url : `http://localhost:${DEFAULT_SYNC_PORT}`
		const follow = args.follow !== false
		const levelFilter = typeof args.level === 'string' ? args.level : null
		const eventsUrl = url.replace(/\/$/, '') + EVENTS_ENDPOINT

		logger.banner()
		logger.info(`Connecting to ${eventsUrl}...`)
		logger.blank()

		try {
			const response = await fetch(eventsUrl)

			if (!response.ok) {
				throw new Error(
					`Failed to connect to ${eventsUrl}: ${response.status} ${response.statusText}`,
				)
			}

			const reader = response.body?.getReader()
			if (!reader) {
				throw new Error('Response body is not readable')
			}

			const decoder = new TextDecoder()
			let buffer = ''

			const processLine = (line: string) => {
				// SSE format: "event: <type>\ndata: <json>\n\n"
				if (line.startsWith('event: ')) {
					return // We handle the data line
				}
				if (line.startsWith('data: ')) {
					const data = line.slice(6)
					try {
						const parsed = JSON.parse(data) as Record<string, unknown>
						const level = String(parsed.level ?? 'info')

						if (levelFilter && level !== levelFilter) return

						const timestamp = parsed.timestamp
							? new Date(parsed.timestamp as number).toISOString()
							: ''
						const event = String(parsed.event ?? 'unknown')
						const nodeId = parsed.nodeId ? ` [${parsed.nodeId}]` : ''
						const session = parsed.sessionId ? ` <${parsed.sessionId}>` : ''
						const count = parsed.count ? ` (${parsed.count})` : ''
						const error = parsed.error ? ` — ${parsed.error}` : ''

						const prefix =
							level === 'error' ? '✗' : level === 'warn' ? '⚠' : '●'
						const color =
							level === 'error'
								? '\x1b[31m'
								: level === 'warn'
									? '\x1b[33m'
									: '\x1b[36m'

						console.log(
							`${color}${prefix}${'\x1b[0m'} ${timestamp.slice(11, 23)} ${event}${nodeId}${session}${count}${error}`,
						)
					} catch {
						// Ignore parse errors on malformed data
					}
				}
			}

			const read = async () => {
				while (true) {
					const { done, value } = await reader.read()
					if (done) break

					buffer += decoder.decode(value, { stream: true })
					const lines = buffer.split('\n')
					buffer = lines.pop() ?? ''

					for (const line of lines) {
						processLine(line.trim())
					}

					if (!follow) break
				}
			}

			await read()
		} catch (error) {
			logger.error(`Failed to connect to ${eventsUrl}`)
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
