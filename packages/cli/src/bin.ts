import { defineCommand, runMain } from 'citty'
import { createCommand } from './commands/create/create-command'

const main = defineCommand({
	meta: {
		name: 'kora',
		description: 'Kora.js — Offline-first application framework',
	},
	subCommands: {
		create: createCommand,
	},
})

runMain(main)
