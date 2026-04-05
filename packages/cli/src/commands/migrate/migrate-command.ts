import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { SchemaDefinition } from '@korajs/core'
import { defineCommand } from 'citty'
import { InvalidProjectError, SchemaNotFoundError } from '../../errors'
import { findProjectRoot, findSchemaFile } from '../../utils/fs-helpers'
import { createLogger } from '../../utils/logger'
import { promptConfirm } from '../../utils/prompt'
import { loadKoraConfig } from '../dev/kora-config'
import { generateMigration } from './migration-generator'
import { runMigration } from './migration-runner'
import { loadSchemaDefinition } from './schema-loader'
import { diffSchemas } from './schema-differ'

const SNAPSHOT_PATH = 'kora/schema.snapshot.json'
const MIGRATIONS_DIR = 'kora/migrations'

interface MigrationManifest {
	id: string
	fromVersion: number
	toVersion: number
	up: string[]
	down: string[]
	summary: string[]
	containsBreakingChanges: boolean
}

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
		force: {
			type: 'boolean',
			description: 'Skip breaking-change confirmation prompts',
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
		const outputDir =
			typeof args['output-dir'] === 'string'
				? resolve(projectRoot, args['output-dir'])
				: resolve(projectRoot, MIGRATIONS_DIR)

		if (!diff.hasChanges) {
			logger.success('No schema changes detected.')
			if (args.apply === true) {
				const sqlitePath = resolveSqliteApplyPath(args.db, projectRoot, config)
				const postgresConnectionString = resolvePostgresConnectionString(config)
				const pending = await listMigrationManifests(outputDir)

				if (pending.length === 0) {
					logger.step('No migration files found to apply.')
					return
				}

				for (const manifest of pending) {
					const report = await runMigration({
						upStatements: manifest.up,
						migrationId: manifest.id,
						fromVersion: manifest.fromVersion,
						toVersion: manifest.toVersion,
						sqlitePath,
						postgresConnectionString,
						projectRoot,
					})

					for (const backend of report.backends) {
						logger.step(
							`  ${manifest.id} -> ${backend.backend}: applied=${backend.statementsApplied}, skipped=${backend.skipped}`,
						)
					}
				}
			}
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

		if (diff.hasBreakingChanges && args['dry-run'] !== true) {
			logger.blank()
			logger.warn('Breaking schema changes detected.')
			const shouldContinue = await confirmBreakingChanges(args.force === true)
			if (!shouldContinue) {
				logger.warn('Migration generation aborted.')
				return
			}
		}

		if (args['dry-run'] === true) {
			logger.blank()
			logger.warn('Dry run enabled: no files written, no migrations applied.')
			return
		}

		await mkdir(outputDir, { recursive: true })

		const migrationPath = await writeMigrationFile(outputDir, diff.fromVersion, diff.toVersion, generated)
		await writeSchemaSnapshot(snapshotFile, currentSchema)

		logger.blank()
		logger.success(`Generated migration: ${migrationPath}`)

		if (args.apply === true) {
			const sqlitePath = resolveSqliteApplyPath(args.db, projectRoot, config)
			const postgresConnectionString = resolvePostgresConnectionString(config)
			const pending = await listMigrationManifests(outputDir)

			for (const manifest of pending) {
				const report = await runMigration({
					upStatements: manifest.up,
					migrationId: manifest.id,
					fromVersion: manifest.fromVersion,
					toVersion: manifest.toVersion,
					sqlitePath,
					postgresConnectionString,
					projectRoot,
				})

				for (const backend of report.backends) {
					logger.step(
						`  ${manifest.id} -> ${backend.backend}: applied=${backend.statementsApplied}, skipped=${backend.skipped}, history=${backend.historyRecorded}`,
					)
				}
			}

			logger.success('Applied pending migrations successfully.')
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

async function confirmBreakingChanges(force: boolean): Promise<boolean> {
	if (force) {
		return true
	}

	if (!isInteractiveTerminal()) {
		throw new Error(
			'Breaking schema changes require confirmation. Re-run with --force to continue or --dry-run to preview.',
		)
	}

	return await promptConfirm('Continue and generate a breaking migration?', false)
}

function isInteractiveTerminal(): boolean {
	return process.stdin.isTTY === true && process.stdout.isTTY === true
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
const migrationId = filename.replace(/\.ts$/, '')

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
	await writeMigrationManifest(join(outputDir, `${migrationId}.json`), {
		id: migrationId,
		fromVersion,
		toVersion,
		up: generated.up,
		down: generated.down,
		summary: generated.summary,
		containsBreakingChanges: generated.containsBreakingChanges,
	})
	return path
}

async function writeMigrationManifest(path: string, manifest: MigrationManifest): Promise<void> {
	await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
}

async function listMigrationManifests(outputDir: string): Promise<MigrationManifest[]> {
	const files = await readdir(outputDir).catch(() => [])
	const migrationFiles = files
		.filter((file) => /^\d{3}-.*\.ts$/.test(file))
		.sort((left, right) => left.localeCompare(right))

	const manifests: MigrationManifest[] = []
	for (const file of migrationFiles) {
		const id = file.replace(/\.ts$/, '')
		const manifestPath = join(outputDir, `${id}.json`)
		const jsonManifest = await readMigrationManifest(manifestPath)

		if (jsonManifest) {
			manifests.push({ ...jsonManifest, id })
			continue
		}

		const migrationPath = join(outputDir, file)
		const sourceManifest = await readMigrationManifestFromSource(migrationPath, id)
		manifests.push(sourceManifest)
	}

	return manifests
}

async function readMigrationManifest(path: string): Promise<MigrationManifest | null> {
	try {
		const content = await readFile(path, 'utf-8')
		return JSON.parse(content) as MigrationManifest
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === 'ENOENT') {
			return null
		}
		throw error
	}
}

async function readMigrationManifestFromSource(
	path: string,
	id: string,
): Promise<MigrationManifest> {
	const content = await readFile(path, 'utf-8')
	const versions = parseVersionsFromMigrationId(id)

	return {
		id,
		fromVersion: versions.fromVersion,
		toVersion: versions.toVersion,
		up: parseStringArrayExport(content, 'up'),
		down: parseStringArrayExport(content, 'down'),
		summary: parseStringArrayExport(content, 'summary'),
		containsBreakingChanges: parseBooleanExport(content, 'containsBreakingChanges'),
	}
}

function parseVersionsFromMigrationId(id: string): { fromVersion: number; toVersion: number } {
	const match = id.match(/-v(\d+)-to-v(\d+)$/)
	if (!match) {
		throw new Error(`Migration id "${id}" does not include a vX-to-vY version suffix.`)
	}

	return {
		fromVersion: Number.parseInt(match[1], 10),
		toVersion: Number.parseInt(match[2], 10),
	}
}

function parseStringArrayExport(source: string, exportName: 'up' | 'down' | 'summary'): string[] {
	const expression = parseExportExpression(source, exportName)
	const parsed = JSON.parse(expression) as unknown
	if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
		throw new Error(`Migration export "${exportName}" must be a string array.`)
	}

	return parsed
}

function parseBooleanExport(source: string, exportName: 'containsBreakingChanges'): boolean {
	const expression = parseLiteralExport(source, exportName)
	if (expression === 'true') return true
	if (expression === 'false') return false
	throw new Error(`Migration export "${exportName}" must be a boolean literal.`)
}

function parseExportExpression(source: string, exportName: string): string {
	const escapedName = exportName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const regex = new RegExp(`export const ${escapedName} = ([\\s\\S]*?) as const`)
	const match = source.match(regex)
	if (!match || !match[1]) {
		throw new Error(`Failed to read migration export "${exportName}".`)
	}

	return match[1].trim()
}

function parseLiteralExport(source: string, exportName: string): string {
	const escapedName = exportName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const regex = new RegExp(`export const ${escapedName} = ([^\n\r]+)`)
	const match = source.match(regex)
	if (!match || !match[1]) {
		throw new Error(`Failed to read migration export "${exportName}".`)
	}

	return match[1].trim()
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
