import { resolve } from 'node:path'
import { defineCommand } from 'citty'
import { InvalidProjectError } from '../../errors'
import { findProjectRoot } from '../../utils/fs-helpers'
import { createLogger } from '../../utils/logger'
import { loadKoraConfig } from '../dev/kora-config'
import { loadSchemaDefinition } from '../migrate/schema-loader'

/**
 * Compact the local client operation log (materialized rows are the baseline).
 */
export const compactCommand = defineCommand({
	meta: {
		name: 'compact',
		description: 'Compact the local Kora operation log after server ack',
	},
	args: {
		db: {
			type: 'string',
			description: 'Path to the local SQLite database (required)',
		},
		schema: {
			type: 'string',
			description: 'Path to schema file',
		},
		strategy: {
			type: 'string',
			description: 'Compaction strategy: after-ack | after-days | never',
			default: 'after-ack',
		},
		days: {
			type: 'number',
			description: 'Age threshold when strategy is after-days',
			default: 30,
		},
	},
	async run({ args }) {
		const logger = createLogger()
		const projectRoot = await findProjectRoot()
		if (!projectRoot) {
			throw new InvalidProjectError(process.cwd())
		}

		const dbPath = typeof args.db === 'string' ? resolve(projectRoot, args.db) : undefined
		if (!dbPath) {
			throw new Error('Missing --db <path> to the local SQLite database file.')
		}

		const config = await loadKoraConfig(projectRoot)
		const schemaPath =
			typeof args.schema === 'string'
				? resolve(projectRoot, args.schema)
				: typeof config?.schema === 'string'
					? resolve(projectRoot, config.schema)
					: undefined
		if (!schemaPath) {
			throw new Error('Could not resolve schema path. Pass --schema <path>.')
		}

		const schema = await loadSchemaDefinition(schemaPath, projectRoot)
		const { BetterSqlite3Adapter } = await import('@korajs/store/better-sqlite3')
		const { Store } = await import('@korajs/store')

		const strategyName = typeof args.strategy === 'string' ? args.strategy : 'after-ack'
		const days = typeof args.days === 'number' ? args.days : 30

		const store = new Store({
			schema,
			adapter: new BetterSqlite3Adapter(dbPath),
		})
		await store.open()

		let result: Awaited<ReturnType<Store['compact']>>
		if (strategyName === 'never') {
			result = await store.compact({ mode: 'never' })
		} else if (strategyName === 'after-days') {
			result = await store.compact({ mode: 'after-days', days })
		} else if (strategyName === 'after-ack') {
			result = await store.compact({ mode: 'after-ack' })
		} else {
			await store.close()
			throw new Error(`Unknown strategy "${strategyName}". Use after-ack, after-days, or never.`)
		}

		await store.close()

		logger.banner()
		logger.success(`Compacted ${result.deletedCount} operation log entries.`)
		for (const [nodeId, seq] of result.watermark) {
			logger.step(`  ${nodeId}: seq <= ${seq}`)
		}
	},
})
