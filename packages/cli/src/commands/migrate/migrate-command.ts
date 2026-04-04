import { defineCommand } from 'citty'
import { InvalidProjectError, SchemaNotFoundError } from '../../errors'
import { findProjectRoot, findSchemaFile } from '../../utils/fs-helpers'
import { createLogger } from '../../utils/logger'

/**
 * The `migrate` command — detects and applies schema migrations.
 * Currently a stub that validates the project and prints planned behavior.
 */
export const migrateCommand = defineCommand({
	meta: {
		name: 'migrate',
		description: 'Detect and apply schema migrations',
	},
	args: {
		apply: {
			type: 'boolean',
			description: 'Apply the migration to the local store',
			default: false,
		},
	},
	async run() {
		const logger = createLogger()

		const projectRoot = await findProjectRoot()
		if (!projectRoot) {
			throw new InvalidProjectError(process.cwd())
		}

		const schemaFile = await findSchemaFile(projectRoot)
		if (!schemaFile) {
			throw new SchemaNotFoundError([
				'src/schema.ts',
				'schema.ts',
				'src/schema.js',
				'schema.js',
			])
		}

		logger.banner()
		logger.info('`kora migrate` will perform the following steps:')
		logger.blank()
		logger.step('  1. Read current schema from local store')
		logger.step(`  2. Compare with schema file at ${schemaFile}`)
		logger.step('  3. Detect added, removed, and changed fields')
		logger.step('  4. Generate a migration file in kora/migrations/')
		logger.step('  5. Optionally apply the migration (--apply)')
		logger.blank()
		logger.warn('This command is not yet implemented. Coming in a future release.')
		logger.step(`Project root: ${projectRoot}`)
	},
})
