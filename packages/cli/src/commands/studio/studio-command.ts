import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineCommand } from 'citty'
import { createLogger } from '../../utils/logger'

/**
 * `kora studio` — the visual window into Kora's data plane.
 *
 * FILE mode (`--db path`): read-only inspection of any Kora database —
 * records with per-field last writers, operation history, causal DAG, time
 * travel, merge audit, sync state.
 *
 * LAB mode (`--lab`): an interactive multi-device sync laboratory running
 * REAL stores, sync engines, and a real server in-process. Create devices,
 * edit data on each, disconnect them, inject chaos (drops, duplicates,
 * reordering, latency), and watch conflicts resolve and devices converge —
 * live, with evidence.
 */
export const studioCommand = defineCommand({
	meta: {
		name: 'studio',
		description: 'Kora Studio: visualize records, operations, and sync — or run the sync lab',
	},
	args: {
		db: {
			type: 'string',
			description: 'Path to a Kora SQLite database file (file mode, read-only)',
		},
		lab: {
			type: 'boolean',
			description: 'Start the interactive multi-device sync laboratory',
		},
		connect: {
			type: 'string',
			description: 'Spectator mode: WebSocket URL of a live Kora sync server (read-only replica)',
		},
		token: {
			type: 'string',
			description: 'Spectator mode: bearer token for the sync auth handshake',
		},
		devices: {
			type: 'string',
			description: 'Lab mode: number of initial devices (default 2)',
		},
		schema: {
			type: 'string',
			description: 'Lab mode: path to a schema file (defaults to a built-in demo schema)',
		},
		port: {
			type: 'string',
			description: 'Port for the Studio UI (default 4321, 0 for a random free port)',
		},
	},
	async run({ args }) {
		const logger = createLogger()

		const port = args.port !== undefined ? Number.parseInt(args.port, 10) : 4321
		if (Number.isNaN(port) || port < 0 || port > 65535) {
			throw new Error(`Invalid port "${args.port}"`)
		}

		const { startStudioServer } = await import('./studio-server')

		if (typeof args.connect === 'string') {
			// SPECTATOR: live read-only replica of a production sync server.
			if (typeof args.schema !== 'string') {
				throw new Error(
					'Spectator mode needs your schema to materialize records: kora studio --connect wss://… --schema ./kora/schema.ts',
				)
			}
			const { loadSchemaDefinition } = await import('../migrate/schema-loader')
			const schema = await loadSchemaDefinition(resolve(process.cwd(), args.schema), process.cwd())

			const { SpectatorManager } = await import('./spectator-manager')
			const spectator = new SpectatorManager({
				url: args.connect,
				schema,
				...(typeof args.token === 'string' ? { token: args.token } : {}),
			})
			await spectator.start()
			const server = await startStudioServer({ port, spectator })

			logger.banner()
			logger.success(`Kora Studio SPECTATOR running at ${server.url}`)
			logger.step(`Watching ${args.connect} (read-only replica — nothing is ever pushed)`)
			logger.step('Press Ctrl+C to stop.')

			const shutdown = async (): Promise<void> => {
				await server.close()
				await spectator.close()
				process.exit(0)
			}
			process.on('SIGINT', () => void shutdown())
			process.on('SIGTERM', () => void shutdown())
			return
		}

		if (args.lab) {
			const { LabManager, defaultLabSchema } = await import('./lab-manager')

			let schema = defaultLabSchema()
			if (typeof args.schema === 'string') {
				const { loadSchemaDefinition } = await import('../migrate/schema-loader')
				schema = await loadSchemaDefinition(resolve(process.cwd(), args.schema), process.cwd())
			}

			const initialDevices =
				args.devices !== undefined ? Math.max(1, Number.parseInt(args.devices, 10) || 2) : 2

			const lab = new LabManager(schema)
			await lab.start(initialDevices)
			const server = await startStudioServer({ port, lab })

			logger.banner()
			logger.success(`Kora Studio LAB running at ${server.url}`)
			logger.step(`${initialDevices} device(s) started against an in-process sync server.`)
			logger.step('Everything in the lab is throwaway — experiment freely.')
			logger.step('Press Ctrl+C to stop.')

			const shutdown = async (): Promise<void> => {
				await server.close()
				await lab.close()
				process.exit(0)
			}
			process.on('SIGINT', () => void shutdown())
			process.on('SIGTERM', () => void shutdown())
			return
		}

		if (typeof args.db !== 'string') {
			throw new Error(
				'Pass --db <path> to inspect a database, --lab for the sync laboratory, or --connect <wss url> for live spectator mode.',
			)
		}
		const dbPath = resolve(process.cwd(), args.db)
		if (!existsSync(dbPath)) {
			throw new Error(`Database file not found: ${dbPath}`)
		}

		const server = await startStudioServer({ port, dbPath })

		logger.banner()
		logger.success(`Kora Studio running at ${server.url}`)
		logger.step(`Database: ${dbPath} (read-only)`)
		logger.step('Press Ctrl+C to stop.')

		const shutdown = async (): Promise<void> => {
			await server.close()
			process.exit(0)
		}
		process.on('SIGINT', () => void shutdown())
		process.on('SIGTERM', () => void shutdown())
	},
})
