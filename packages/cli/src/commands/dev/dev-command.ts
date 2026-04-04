import { defineCommand } from 'citty'
import { InvalidProjectError } from '../../errors'
import { findProjectRoot } from '../../utils/fs-helpers'
import { createLogger } from '../../utils/logger'

/**
 * The `dev` command — starts the Kora development environment.
 * Currently a stub that validates the project and prints planned behavior.
 */
export const devCommand = defineCommand({
	meta: {
		name: 'dev',
		description: 'Start the Kora development environment',
	},
	args: {
		port: {
			type: 'string',
			description: 'Vite dev server port',
			default: '5173',
		},
		'sync-port': {
			type: 'string',
			description: 'Kora sync server port',
			default: '3001',
		},
	},
	async run({ args }) {
		const logger = createLogger()

		const projectRoot = await findProjectRoot()
		if (!projectRoot) {
			throw new InvalidProjectError(process.cwd())
		}

		logger.banner()
		logger.info('`kora dev` will start the following services:')
		logger.blank()
		logger.step(`  Vite dev server on port ${args.port}`)
		logger.step(`  Kora sync server on port ${args['sync-port']} (if configured)`)
		logger.step('  Schema file watcher (auto-regenerate types on change)')
		logger.step('  Embedded DevTools (Ctrl+Shift+K)')
		logger.blank()
		logger.warn('This command is not yet implemented. Coming in a future release.')
		logger.step(`Project root: ${projectRoot}`)
	},
})
