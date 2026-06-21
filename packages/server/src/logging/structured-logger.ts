/**
 * Log severity levels.
 */
export type LogLevel = 'info' | 'warn' | 'error'

/**
 * A structured log entry with timestamp and metadata.
 */
export interface LogEntry {
	timestamp: number
	level: LogLevel
	event: string
	sessionId?: string
	nodeId?: string
	duration?: number
	count?: number
	bytes?: number
	error?: string
	details?: Record<string, unknown>
}

/**
 * Logger interface for structured logging.
 * Implementations control output format and destination.
 */
export interface Logger {
	log(entry: LogEntry): void
	child?(context: Partial<LogEntry>): Logger
}

/**
 * Serializes LogEntry to a single log line.
 */
export type LogSerializer = (entry: LogEntry) => string

function defaultJsonSerializer(entry: LogEntry): string {
	return JSON.stringify(entry)
}

function defaultPrettySerializer(entry: LogEntry): string {
	const time = new Date(entry.timestamp).toISOString().slice(11, 23)
	const levelTag = { info: ' INFO', warn: ' WARN', error: 'ERROR' }[entry.level]
	const node = entry.nodeId ? ` [${entry.nodeId.slice(0, 8)}]` : ''
	const session = entry.sessionId ? ` [session:${entry.sessionId.slice(0, 8)}]` : ''
	const dur = entry.duration !== undefined ? ` +${entry.duration}ms` : ''
	const count = entry.count !== undefined ? ` (${entry.count})` : ''
	const err = entry.error ? ` — ${entry.error}` : ''
	return `${time} ${levelTag}${node}${session} ${entry.event}${count}${dur}${err}`
}

/**
 * Creates a JSON-lines logger that writes to stdout/stderr.
 * Suitable for production use where log aggregators (Datadog, Loki, etc.) consume JSON.
 */
export function createJsonLogger(writer?: {
	info: (s: string) => void
	error: (s: string) => void
}): Logger {
	const out = writer ?? {
		info: (s: string) => process.stdout.write(`${s}\n`),
		error: (s: string) => process.stderr.write(`${s}\n`),
	}

	return {
		log(entry: LogEntry): void {
			const line = defaultJsonSerializer(entry)
			if (entry.level === 'error') {
				out.error(line)
			} else {
				out.info(line)
			}
		},
	}
}

/**
 * Creates a pretty-printed logger for development use.
 * Writes human-readable colored output to the terminal.
 */
export function createPrettyLogger(writer?: { write: (s: string) => void }): Logger {
	const out = writer ?? { write: (s: string) => process.stdout.write(`${s}\n`) }

	return {
		log(entry: LogEntry): void {
			out.write(defaultPrettySerializer(entry))
		},
	}
}

/**
 * A logger that discards all entries (for testing or when logging is disabled).
 */
export function createSilentLogger(): Logger {
	return { log() {} }
}

/**
 * Creates a logger based on the NODE_ENV environment variable.
 * - production: JSON lines to stdout/stderr
 * - test: silent
 * - otherwise: pretty-printed to stdout
 */
export function createDefaultLogger(): Logger {
	switch (process.env.NODE_ENV) {
		case 'production':
			return createJsonLogger()
		case 'test':
			return createSilentLogger()
		default:
			return createPrettyLogger()
	}
}
