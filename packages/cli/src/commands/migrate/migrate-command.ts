import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { SchemaDefinition } from '@kora/core'
import { defineCommand } from 'citty'
import { InvalidProjectError, SchemaNotFoundError } from '../../errors'
import { findProjectRoot, findSchemaFile } from '../../utils/fs-helpers'
import { createLogger } from '../../utils/logger'
import { loadKoraConfig } from '../dev/kora-config'
import { generateMigration } from './migration-generator'
import { runMigration } from './migration-runner'
import { loadSchemaDefinition } from './schema-loader'
import { diffSchemas } from './schema-differ'

const SNAPSHOT_PATH = 'kora/schema.snapshot.json'
const MIGRATIONS_DIR = 'kora/migrations'

/**
 * The `migrate` command — detects schema changes and generates migration artifacts.
 */
export const migrateCommand = defineCommand({
	meta: {
		name: 'migrate',
		description: 'Detect schema changes and generate/apply migrations',
	},
	args: {
		apply: {
			type: 'boolean',
			description: 'Apply migration to configured database backends',
			default: false,
		},
		schema: {
			type: 'string',
			description: 'Path to schema file',
		},
		db: {
			type: 'string',
			description: 'SQLite database path for --apply (overrides config)',
		},
		'output-dir': {
			type: 'string',
			description: 'Migration output directory',
			default: MIGRATIONS_DIR,
		},
		'dry-run': {
			type: 'boolean',
			description: 'Preview migration changes without writing files',
			default: false,
		},
	},
	async run({ args }) {
		const logger = createLogger()

		const projectRoot = await findProjectRoot()
		if (!projectRoot) {
			throw new InvalidProjectError(process.cwd())
		}

		const config = await loadKoraConfig(projectRoot)
		const resolvedSchemaPath =
			typeof args.schema === 'string'
				? resolve(projectRoot, args.schema)
				: typeof config?.schema === 'string'
					? resolve(projectRoot, config.schema)
					: await findSchemaFile(projectRoot)

		if (!resolvedSchemaPath) {
			throw new SchemaNotFoundError(['src/schema.ts', 'schema.ts', 'src/schema.js', 'schema.js'])
		}

		const currentSchema = await loadSchemaDefinition(resolvedSchemaPath, projectRoot)

		const snapshotFile = join(projectRoot, SNAPSHOT_PATH)
		const previousSchema = await readSchemaSnapshot(snapshotFile)

		if (!previousSchema) {
			if (args['dry-run'] === true) {
				logger.info('No schema snapshot found. Dry run: baseline snapshot would be created.')
				return
			}

			await writeSchemaSnapshot(snapshotFile, currentSchema)
			logger.success(`Initialized schema snapshot at ${snapshotFile}`)
			logger.step('Run `kora migrate` again after schema changes to generate migrations.')
			return
		}

		const diff = diffSchemas(previousSchema, currentSchema)
		if (!diff.hasChanges) {
			logger.success('No schema changes detected.')
			return
		}

		const generated = generateMigration(previousSchema, currentSchema, diff)

		logger.banner()
		logger.info(`Detected schema change: v${diff.fromVersion} → v${diff.toVersion}`)
		logger.blank()
		logger.info('Changes:')
		for (const line of generated.summary) {
			logger.step(`  ${line}`)
		}

		if (args['dry-run'] === true) {
			logger.blank()
			logger.warn('Dry run enabled: no files written, no migrations applied.')
			return
		}

		const outputDir =
			typeof args['output-dir'] === 'string'
				? resolve(projectRoot, args['output-dir'])
				: resolve(projectRoot, MIGRATIONS_DIR)
		await mkdir(outputDir, { recursive: true })

		const migrationPath = await writeMigrationFile(outputDir, diff.fromVersion, diff.toVersion, generated)
		await writeSchemaSnapshot(snapshotFile, currentSchema)

		logger.blank()
		logger.success(`Generated migration: ${migrationPath}`)

		if (args.apply === true) {
			const sqlitePath = resolveSqliteApplyPath(args.db, projectRoot, config)
			const postgresConnectionString = resolvePostgresConnectionString(config)

			await runMigration({
				upStatements: generated.up,
				sqlitePath,
				postgresConnectionString,
				projectRoot,
			})

			logger.success('Applied migration statements successfully.')
		}
	},
})

async function readSchemaSnapshot(path: string): Promise<SchemaDefinition | null> {
	try {
		const content = await readFile(path, 'utf-8')
		return JSON.parse(content) as SchemaDefinition
	} catch {
		return null
	}
}

async function writeSchemaSnapshot(path: string, schema: SchemaDefinition): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, `${JSON.stringify(schema, null, 2)}\n`, 'utf-8')
}

async function writeMigrationFile(
	outputDir: string,
	fromVersion: number,
	toVersion: number,
	generated: ReturnType<typeof generateMigration>,
): Promise<string> {
	const existing = await readdir(outputDir).catch(() => [])
	const sequence = existing.filter((file) => /^\d{3}-/.test(file)).length + 1
	const filename = `${String(sequence).padStart(3, '0')}-v${fromVersion}-to-v${toVersion}.ts`
	const path = join(outputDir, filename)

	const fileContent = [
		`export const up = ${JSON.stringify(generated.up, null, 2)} as const`,
		'',
		`export const down = ${JSON.stringify(generated.down, null, 2)} as const`,
		'',
		`export const summary = ${JSON.stringify(generated.summary, null, 2)} as const`,
		'',
		`export const containsBreakingChanges = ${generated.containsBreakingChanges}`,
		'',
	].join('\n')

	await writeFile(path, fileContent, 'utf-8')
	return path
}

function resolveSqliteApplyPath(
	dbArg: unknown,
	projectRoot: string,
	config: Awaited<ReturnType<typeof loadKoraConfig>>,
): string | undefined {
	if (typeof dbArg === 'string') {
		return resolve(projectRoot, dbArg)
	}

	const sync = config?.dev?.sync
	if (typeof sync === 'object' && sync !== null) {
		if (sync.store === 'sqlite') {
			return join(projectRoot, 'kora-sync.db')
		}
		if (typeof sync.store === 'object' && sync.store !== null && sync.store.type === 'sqlite') {
			if (typeof sync.store.filename === 'string' && sync.store.filename.length > 0) {
				return resolve(projectRoot, sync.store.filename)
			}
			return join(projectRoot, 'kora-sync.db')
		}
	}

	return undefined
}

function resolvePostgresConnectionString(
	config: Awaited<ReturnType<typeof loadKoraConfig>>,
): string | undefined {
	const sync = config?.dev?.sync
	if (typeof sync !== 'object' || sync === null) return undefined

	if (sync.store === 'postgres') {
		return process.env.DATABASE_URL
	}

	if (typeof sync.store === 'object' && sync.store !== null && sync.store.type === 'postgres') {
		return sync.store.connectionString
	}

	return undefined
}
