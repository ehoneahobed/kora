import { defineCommand, runMain } from 'citty'
import { agentsCommand } from './commands/agents/agents-command'
import { backupCommand } from './commands/backup/backup-command'
import { compactCommand } from './commands/compact/compact-command'
import { createCommand } from './commands/create/create-command'
import { deployCommand } from './commands/deploy/deploy-command'
import { devCommand } from './commands/dev/dev-command'
import { doctorCommand } from './commands/doctor/doctor-command'
import { generateCommand } from './commands/generate/generate-command'
import { logsCommand } from './commands/logs/logs-command'
import { migrateCommand } from './commands/migrate/migrate-command'
import { statusCommand } from './commands/status/status-command'
import { studioCommand } from './commands/studio/studio-command'

const main = defineCommand({
	meta: {
		name: 'kora',
		description: 'Kora.js, the offline-first application framework',
	},
	subCommands: {
		'agents-md': agentsCommand,
		backup: backupCommand,
		compact: compactCommand,
		create: createCommand,
		dev: devCommand,
		doctor: doctorCommand,
		deploy: deployCommand,
		generate: generateCommand,
		logs: logsCommand,
		migrate: migrateCommand,
		status: statusCommand,
		studio: studioCommand,
	},
})

runMain(main)
