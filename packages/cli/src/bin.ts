import { defineCommand, runMain } from 'citty'
import { createCommand } from './commands/create/create-command'
import { deployCommand } from './commands/deploy/deploy-command'
import { devCommand } from './commands/dev/dev-command'
import { generateCommand } from './commands/generate/generate-command'
import { migrateCommand } from './commands/migrate/migrate-command'

const main = defineCommand({
	meta: {
		name: 'kora',
		description: 'Kora.js — Offline-first application framework',
	},
	subCommands: {
		create: createCommand,
		dev: devCommand,
		deploy: deployCommand,
		generate: generateCommand,
		migrate: migrateCommand,
	},
})

runMain(main)
