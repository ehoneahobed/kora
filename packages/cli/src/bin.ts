import { defineCommand, runMain } from 'citty'
import { backupCommand } from './commands/backup/backup-command'
import { createCommand } from './commands/create/create-command'
import { deployCommand } from './commands/deploy/deploy-command'
import { devCommand } from './commands/dev/dev-command'
import { generateCommand } from './commands/generate/generate-command'
import { logsCommand } from './commands/logs/logs-command'
import { migrateCommand } from './commands/migrate/migrate-command'
import { statusCommand } from './commands/status/status-command'

const main = defineCommand({
	meta: {
		name: 'kora',
		description: 'Kora.js — Offline-first application framework',
	},
	subCommands: {
		backup: backupCommand,
		create: createCommand,
		dev: devCommand,
		deploy: deployCommand,
		generate: generateCommand,
		logs: logsCommand,
		migrate: migrateCommand,
		status: statusCommand,
	},
})

runMain(main)
