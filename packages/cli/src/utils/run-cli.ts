import { KoraError } from '@korajs/core'
import { type CommandDef, runCommand, runMain } from 'citty'
import { createLogger } from './logger'

/**
 * Runs the CLI. A KoraError is a failure the CLI expected and explained, so only its message is
 * printed, once. Help, versions, citty's own usage errors and unexpected failures (which keep
 * their stack, to be reported) go through citty's runMain as before.
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
		if (error instanceof KoraError) {
			createLogger().error(error.message)
			process.exit(1)
		}
		// Let citty report it: usage for an unknown command, the stack for a bug.
		await runMain(
			{ ...main, run: () => Promise.reject(error), subCommands: undefined },
			{ rawArgs: [] },
		)
	}
}
