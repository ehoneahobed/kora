import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineCommand } from 'citty'
import { createLogger } from '../../utils/logger'

const DEFAULT_SYNC_PORT = 3001

/**
 * The `backup` command — creates and restores Kora sync server backups.
 */
export const backupCommand = defineCommand({
	meta: {
		name: 'backup',
		description: 'Backup and restore Kora sync server data',
	},
	subCommands: {
		create: defineCommand({
			meta: {
				name: 'create',
				description: 'Create a backup of the sync server',
			},
			args: {
				url: {
					type: 'string',
					description: 'Sync server URL (default: http://localhost:3001)',
					default: `http://localhost:${DEFAULT_SYNC_PORT}`,
				},
				out: {
					type: 'string',
					description: 'Output file path (default: kora-backup-<timestamp>.kora)',
				},
				token: {
					type: 'string',
					description: 'Backup token (defaults to KORA_BACKUP_TOKEN or KORA_ADMIN_TOKEN)',
				},
			},
			async run({ args }) {
				const logger = createLogger()
				const url =
					typeof args.url === 'string' ? args.url : `http://localhost:${DEFAULT_SYNC_PORT}`
				const outFile = typeof args.out === 'string' ? args.out : `kora-backup-${Date.now()}.kora`
				const token =
					typeof args.token === 'string'
						? args.token
						: (process.env.KORA_BACKUP_TOKEN ?? process.env.KORA_ADMIN_TOKEN)

				logger.banner()
				logger.info(`Exporting backup from ${url}...`)

				try {
					const backupUrl = `${url.replace(/\/$/, '')}/__kora/backup/export`
					const response = await fetch(backupUrl, {
						method: 'POST',
						headers: token ? { Authorization: `Bearer ${token}` } : undefined,
					})

					if (!response.ok) {
						const error = await response.json().catch(() => ({ message: response.statusText }))
						throw new Error(
							`Backup failed: ${(error as { message: string }).message ?? response.statusText}`,
						)
					}

					const buffer = await response.arrayBuffer()
					await writeFile(outFile, new Uint8Array(buffer))

					const size = (buffer.byteLength / 1024).toFixed(1)
					logger.success(`Backup saved to ${outFile} (${size} KB)`)
				} catch (error) {
					logger.error('Backup failed')
					if (error instanceof Error) logger.error(error.message)
					logger.blank()
					logger.step('Make sure the Kora sync server is running.')
					process.exit(1)
				}
			},
		}),

		restore: defineCommand({
			meta: {
				name: 'restore',
				description: 'Restore a backup to the sync server',
			},
			args: {
				file: {
					type: 'string',
					description: 'Backup file path',
					required: true,
				},
				url: {
					type: 'string',
					description: 'Sync server URL (default: http://localhost:3001)',
					default: `http://localhost:${DEFAULT_SYNC_PORT}`,
				},
				merge: {
					type: 'boolean',
					description: 'Merge with existing data instead of replacing',
					default: false,
				},
				token: {
					type: 'string',
					description: 'Backup token (defaults to KORA_BACKUP_TOKEN or KORA_ADMIN_TOKEN)',
				},
			},
			async run({ args }) {
				const logger = createLogger()
				const filePath = typeof args.file === 'string' ? args.file : ''
				const url =
					typeof args.url === 'string' ? args.url : `http://localhost:${DEFAULT_SYNC_PORT}`
				const merge = args.merge === true
				const token =
					typeof args.token === 'string'
						? args.token
						: (process.env.KORA_BACKUP_TOKEN ?? process.env.KORA_ADMIN_TOKEN)

				logger.banner()
				logger.info(`Restoring backup from ${filePath} to ${url}...`)

				try {
					const data = await readFile(filePath)
					const restoreUrl = `${url.replace(/\/$/, '')}/__kora/backup/import?merge=${merge}`

					const response = await fetch(restoreUrl, {
						method: 'POST',
						headers: token ? { Authorization: `Bearer ${token}` } : undefined,
						body: data,
					})

					if (!response.ok) {
						const error = await response.json().catch(() => ({ message: response.statusText }))
						throw new Error(
							`Restore failed: ${(error as { message: string }).message ?? response.statusText}`,
						)
					}

					const result = (await response.json()) as {
						operationsRestored: number
						success: boolean
						duration?: number
					}

					if (result.success) {
						logger.success(
							`Restored ${result.operationsRestored} operations${result.duration ? ` in ${result.duration}ms` : ''}`,
						)
					} else {
						logger.error('Restore completed with errors')
					}
				} catch (error) {
					logger.error('Restore failed')
					if (error instanceof Error) logger.error(error.message)
					process.exit(1)
				}
			},
		}),

		info: defineCommand({
			meta: {
				name: 'info',
				description: 'Show backup file information',
			},
			args: {
				file: {
					type: 'string',
					description: 'Backup file path',
					required: true,
				},
			},
			async run({ args }) {
				const logger = createLogger()
				const filePath = typeof args.file === 'string' ? args.file : ''

				try {
					const data = await readFile(filePath)
					const { readBackupManifest } = await import('@korajs/store')

					const manifest = readBackupManifest(
						new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
					)

					logger.banner()
					logger.info(`Backup: ${filePath}`)
					logger.blank()
					logger.step(`Created:     ${new Date(manifest.createdAt).toISOString()}`)
					logger.step(`Node ID:     ${manifest.nodeId}`)
					logger.step(`Schema:      v${manifest.schemaVersion}`)
					logger.step(`Operations:  ${manifest.operationCount.toLocaleString()}`)
					logger.step(`Collections: ${manifest.collections.join(', ') || '(none)'}`)
					logger.step(`Checksum:    ${manifest.checksum.slice(0, 16)}...`)
					logger.blank()
					logger.step(`Format version: ${manifest.version}`)
				} catch (error) {
					logger.error('Failed to read backup file')
					if (error instanceof Error) logger.error(error.message)
					process.exit(1)
				}
			},
		}),
	},
})
