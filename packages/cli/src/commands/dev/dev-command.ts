import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { defineCommand } from 'citty'
import { DevServerError, InvalidProjectError } from '../../errors'
import { findProjectRoot, findSchemaFile, resolveProjectBinary } from '../../utils/fs-helpers'
import { createLogger } from '../../utils/logger'
import { ProcessManager } from './process-manager'
import { SchemaWatcher } from './schema-watcher'

/**
 * The `dev` command — starts the Kora development environment.
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
		'no-sync': {
			type: 'boolean',
			description: 'Disable sync server startup',
			default: false,
		},
		'no-watch': {
			type: 'boolean',
			description: 'Disable schema file watching',
			default: false,
		},
	},
	async run({ args }) {
		const logger = createLogger()

		const projectRoot = await findProjectRoot()
		if (!projectRoot) {
			throw new InvalidProjectError(process.cwd())
		}

		const viteBinary = await resolveProjectBinary(projectRoot, 'vite')
		if (!viteBinary) {
			throw new DevServerError('vite', join(projectRoot, 'node_modules', '.bin', 'vite'))
		}

		const syncServerFile = await findSyncServerFile(projectRoot)
		const syncAllowed = args['no-sync'] !== true
		const shouldStartSync = syncAllowed && syncServerFile !== null

		let syncBinary: string | null = null
		if (shouldStartSync) {
			syncBinary = await resolveProjectBinary(projectRoot, 'tsx')
			if (!syncBinary) {
				logger.warn('Sync server detected, but local "tsx" binary was not found. Skipping sync.')
			}
		}

		const schemaPath = await findSchemaFile(projectRoot)
		const watchEnabled = args['no-watch'] !== true && schemaPath !== null

		const processManager = new ProcessManager()
		let schemaWatcher: SchemaWatcher | null = null
		let shuttingDown = false
		let resolveFinished: (() => void) | undefined
		const finished = new Promise<void>((resolve) => {
			resolveFinished = resolve
		})

		const onManagedProcessExit = () => {
			if (!processManager.hasRunning() && !shuttingDown) {
				resolveFinished?.()
			}
		}

		const shutdown = async () => {
			if (shuttingDown) return
			shuttingDown = true
			schemaWatcher?.stop()
			await processManager.shutdownAll()
			resolveFinished?.()
		}

		const onSigInt = () => {
			void shutdown()
		}
		const onSigTerm = () => {
			void shutdown()
		}

		process.on('SIGINT', onSigInt)
		process.on('SIGTERM', onSigTerm)

		logger.banner()
		logger.info('Starting development environment:')
		logger.blank()
		logger.step(`  Vite dev server on port ${args.port}`)
		if (shouldStartSync && syncBinary && syncServerFile) {
			logger.step(`  Sync server on port ${args['sync-port']}`)
		} else if (syncAllowed && syncServerFile === null) {
			logger.step('  Sync server not detected (no server.ts/server.js)')
		} else if (!syncAllowed) {
			logger.step('  Sync server disabled via --no-sync')
		}

		if (watchEnabled && schemaPath) {
			logger.step(`  Schema watcher enabled (${schemaPath})`)
		} else if (args['no-watch'] === true) {
			logger.step('  Schema watcher disabled via --no-watch')
		} else {
			logger.step('  Schema watcher disabled (schema.ts not found)')
		}
		logger.blank()

		processManager.spawn({
			label: 'vite',
			command: viteBinary,
			args: ['--port', String(args.port)],
			cwd: projectRoot,
			onExit: onManagedProcessExit,
		})

		if (shouldStartSync && syncBinary && syncServerFile) {
			processManager.spawn({
				label: 'sync',
				command: syncBinary,
				args: [syncServerFile],
				cwd: projectRoot,
				env: {
					PORT: String(args['sync-port']),
					KORA_SYNC_PORT: String(args['sync-port']),
				},
				onExit: onManagedProcessExit,
			})
		}

		if (watchEnabled && schemaPath) {
			schemaWatcher = new SchemaWatcher({
				schemaPath,
				projectRoot,
				onRegenerate: () => {
					logger.success('Regenerated types from schema changes')
				},
				onError: (error) => {
					logger.error(`Schema watcher error: ${error.message}`)
				},
			})
			schemaWatcher.start()
		}

		await finished
		process.off('SIGINT', onSigInt)
		process.off('SIGTERM', onSigTerm)
	},
})

async function findSyncServerFile(projectRoot: string): Promise<string | null> {
	const candidates = [join(projectRoot, 'server.ts'), join(projectRoot, 'server.js')]

	for (const candidate of candidates) {
		try {
			await access(candidate)
			return candidate
		} catch {
			// continue
		}
	}

	return null
}
