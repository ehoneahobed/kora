/** ANSI escape codes for terminal colors */
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'

export interface LoggerOptions {
	/** Disable ANSI colors */
	noColor?: boolean
}

export interface Logger {
	info(message: string): void
	success(message: string): void
	warn(message: string): void
	error(message: string): void
	step(message: string): void
	blank(): void
	banner(): void
}

/**
 * Creates a logger with optional ANSI color support.
 * Respects the NO_COLOR environment variable and TTY detection.
 */
export function createLogger(options?: LoggerOptions): Logger {
	const colorDisabled =
		options?.noColor === true || process.env.NO_COLOR !== undefined || !process.stdout.isTTY

	function color(code: string, text: string): string {
		return colorDisabled ? text : `${code}${text}${RESET}`
	}

	return {
		info(message: string): void {
			console.log(color(CYAN, message))
		},
		success(message: string): void {
			console.log(color(GREEN, `  ✓ ${message}`))
		},
		warn(message: string): void {
			console.warn(color(YELLOW, `  ⚠ ${message}`))
		},
		error(message: string): void {
			console.error(color(RED, `  ✗ ${message}`))
		},
		step(message: string): void {
			console.log(color(DIM, `  ${message}`))
		},
		blank(): void {
			console.log()
		},
		banner(): void {
			console.log()
			console.log(
				color(BOLD + CYAN, '  Kora.js') + color(DIM, ' — Offline-first application framework'),
			)
			console.log()
		},
	}
}
