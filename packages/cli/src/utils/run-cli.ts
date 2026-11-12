import { KoraError } from '@korajs/core'
import { type CommandDef, runCommand, runMain } from 'citty'
import { createLogger } from './logger'

/**
 * Runs the CLI. A failure prints its message once: a KoraError is one the CLI expected and
 * explained; any other error's stack is printed only with `KORA_DEBUG=1`, with a hint saying so.
 * Help, versions and citty's own usage errors (an unknown command, a missing argument) go
 * through citty, which shows the usage they need.
 */
export async function runCli(main: CommandDef, rawArgs: string[]): Promise<void> {
	if (
		rawArgs.includes('--help') ||
		rawArgs.includes('-h') ||
		(rawArgs.length === 1 && rawArgs[0] === '--version')
	) {
		await runMain(main, { rawArgs })
		return
	}
	try {
		await runCommand(main, { rawArgs })
	} catch (error) {
		const logger = createLogger()
		if (error instanceof KoraError) {
			logger.error(error.message)
			process.exit(1)
		}
		if (isCittyUsageError(error)) {
			await runMain(
				{ ...main, run: () => Promise.reject(error), subCommands: undefined },
				{ rawArgs: [] },
			)
			return
		}
		logger.error(error instanceof Error ? error.message : String(error))
		if (process.env.KORA_DEBUG && error instanceof Error && error.stack) {
			console.error(error.stack)
		} else {
			logger.step('Run again with KORA_DEBUG=1 to see where it happened.')
		}
		process.exit(1)
	}
}

/** citty's own argument errors (`CLIError`), which need the usage text shown with them. */
function isCittyUsageError(error: unknown): boolean {
	return error instanceof Error && error.name === 'CLIError'
}
