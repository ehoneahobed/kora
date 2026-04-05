import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { defineCommand } from 'citty'
import { DevServerError, InvalidProjectError } from '../../errors'
import { findProjectRoot, findSchemaFile, resolveProjectBinary } from '../../utils/fs-helpers'
import { createLogger } from '../../utils/logger'
import { loadKoraConfig } from './kora-config'
import type { KoraConfigFile } from './kora-config'
import { ProcessManager } from './process-manager'
import { SchemaWatcher } from './schema-watcher'

interface ManagedSyncStoreConfig {
	type: 'memory' | 'sqlite' | 'postgres'
	filename?: string
	connectionString?: string
}

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
		},
		'sync-port': {
			type: 'string',
			description: 'Kora sync server port',
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

		const config = await loadKoraConfig(projectRoot)
		const vitePort = typeof args.port === 'string' ? args.port : String(config?.dev?.port ?? 5173)
		const syncPortFromConfig =
			typeof config?.dev?.sync === 'object' && typeof config.dev.sync.port === 'number'
				? config.dev.sync.port
				: 3001
		const syncPort =
			typeof args['sync-port'] === 'string' ? args['sync-port'] : String(syncPortFromConfig)

		const configSyncEnabled =
			config?.dev?.sync === undefined ||
			config.dev.sync === true ||
			(typeof config.dev.sync === 'object' && config.dev.sync.enabled !== false)

		const configWatchEnabled =
			config?.dev?.watch === undefined ||
			config.dev.watch === true ||
			(typeof config.dev.watch === 'object' && config.dev.watch.enabled !== false)

		const watchDebounceMs =
			typeof config?.dev?.watch === 'object' && typeof config.dev.watch.debounceMs === 'number'
				? config.dev.watch.debounceMs
				: 300

		const viteBinary = await resolveProjectBinary(projectRoot, 'vite')
		if (!viteBinary) {
			throw new DevServerError('vite', join(projectRoot, 'node_modules', '.bin', 'vite'))
		}

		const syncServerFile = await findSyncServerFile(projectRoot)
		let managedSyncStore = normalizeManagedSyncStore(config, projectRoot)
		const postgresEnvRequested = isPostgresEnvRequested(config)
		const syncAllowed = args['no-sync'] !== true && configSyncEnabled
		let shouldStartSync = syncAllowed && (syncServerFile !== null || managedSyncStore !== null)

		let syncBinary: string | null = null
		if (shouldStartSync && syncServerFile !== null) {
			syncBinary = await resolveProjectBinary(projectRoot, 'tsx')
			if (!syncBinary) {
				logger.warn('Sync server detected, but local "tsx" binary was not found. Skipping sync.')
			}
		}

		if (shouldStartSync && syncServerFile === null && managedSyncStore) {
			const hasServerPackage = await fileExists(
				join(projectRoot, 'node_modules', '@korajs', 'server', 'package.json'),
			)
			if (!hasServerPackage) {
				logger.warn(
					'Managed sync is configured, but @korajs/server is not installed. Install it or add server.ts.',
				)
				managedSyncStore = null
				shouldStartSync = syncAllowed && (syncServerFile !== null || managedSyncStore !== null)
			}
		}

		if (syncAllowed && syncServerFile === null && managedSyncStore === null && postgresEnvRequested) {
			logger.warn(
				'Managed postgres sync requested but no connection string found. Set dev.sync.store.connectionString or DATABASE_URL.',
			)
		}

		let configuredSchemaPath: string | null = null
		if (typeof config?.schema === 'string') {
			const candidate = resolve(projectRoot, config.schema)
			if (await fileExists(candidate)) {
				configuredSchemaPath = candidate
			} else {
				logger.warn(`Configured schema file not found: ${candidate}. Falling back to auto-detection.`)
			}
		}

		const schemaPath = configuredSchemaPath ?? (await findSchemaFile(projectRoot))
		const watchEnabled = args['no-watch'] !== true && configWatchEnabled && schemaPath !== null

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
		logger.step(`  Vite dev server on port ${vitePort}`)
		if (shouldStartSync && syncBinary && syncServerFile) {
			logger.step(`  Sync server on port ${syncPort}`)
		} else if (shouldStartSync && syncServerFile === null && managedSyncStore !== null) {
			logger.step(`  Managed sync server on port ${syncPort} (${managedSyncStore.type})`)
		} else if (syncAllowed && syncServerFile === null) {
			logger.step('  Sync server configured but no server.ts/server.js or managed store found')
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
			args: ['--port', String(vitePort)],
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
					PORT: String(syncPort),
					KORA_SYNC_PORT: String(syncPort),
				},
				onExit: onManagedProcessExit,
			})
		}

		if (shouldStartSync && syncServerFile === null && managedSyncStore !== null) {
			processManager.spawn({
				label: 'sync',
				command: process.execPath,
				args: ['--input-type=module', '--eval', MANAGED_SYNC_BOOTSTRAP_SCRIPT],
				cwd: projectRoot,
				env: {
					KORA_DEV_SYNC_CONFIG: JSON.stringify({
						port: Number(syncPort),
						store: managedSyncStore,
					}),
				},
				onExit: onManagedProcessExit,
			})
		}

		if (watchEnabled && schemaPath) {
			schemaWatcher = new SchemaWatcher({
				schemaPath,
				projectRoot,
				debounceMs: watchDebounceMs,
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

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

function normalizeManagedSyncStore(
	config: KoraConfigFile | null,
	projectRoot: string,
): ManagedSyncStoreConfig | null {
	const sync = config?.dev?.sync
	if (typeof sync !== 'object' || sync === null) return null

	const store = sync.store
	if (store === undefined) return { type: 'memory' }

	if (store === 'memory') return { type: 'memory' }
	if (store === 'sqlite') return { type: 'sqlite', filename: join(projectRoot, 'kora-sync.db') }
	if (store === 'postgres') {
		const connectionString = process.env.DATABASE_URL
		if (!connectionString) return null
		return { type: 'postgres', connectionString }
	}

	if (typeof store === 'object' && store !== null) {
		if (store.type === 'memory') return { type: 'memory' }
		if (store.type === 'sqlite') {
			const filename =
				typeof store.filename === 'string' && store.filename.length > 0
					? resolve(projectRoot, store.filename)
					: join(projectRoot, 'kora-sync.db')
			return { type: 'sqlite', filename }
		}
		if (store.type === 'postgres' && typeof store.connectionString === 'string') {
			return { type: 'postgres', connectionString: store.connectionString }
		}
	}

	return null
}

function isPostgresEnvRequested(config: KoraConfigFile | null): boolean {
	const sync = config?.dev?.sync
	if (typeof sync !== 'object' || sync === null) return false
	if (sync.store === 'postgres') return true
	if (typeof sync.store === 'object' && sync.store !== null && sync.store.type === 'postgres') return true
	return false
}

const MANAGED_SYNC_BOOTSTRAP_SCRIPT = `
const config = JSON.parse(process.env.KORA_DEV_SYNC_CONFIG ?? '{}');
const {
  createKoraServer,
  MemoryServerStore,
  createSqliteServerStore,
  createPostgresServerStore,
} = await import('@korajs/server');
const storeConfig = config.store ?? { type: 'memory' };
let store;
if (storeConfig.type === 'memory') {
  store = new MemoryServerStore();
} else if (storeConfig.type === 'sqlite') {
  const filename = typeof storeConfig.filename === 'string' && storeConfig.filename.length > 0
    ? storeConfig.filename
    : './kora-sync.db';
  store = createSqliteServerStore({ filename });
} else if (storeConfig.type === 'postgres') {
  if (typeof storeConfig.connectionString !== 'string' || storeConfig.connectionString.length === 0) {
    throw new Error('Managed postgres sync requires a connectionString');
  }
  store = await createPostgresServerStore({
    connectionString: storeConfig.connectionString,
  });
} else {
  throw new Error('Unsupported managed sync store type: ' + String(storeConfig.type));
}
const server = createKoraServer({ store, port: Number(config.port ?? 3001) });
const shutdown = async () => {
  try {
    await server.stop();
  } catch {
  }
  process.exit(0);
};
process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
await server.start();
process.stdout.write('Managed sync server running on ws://localhost:' + String(config.port ?? 3001) + '\\n');
await new Promise(() => {});
`
