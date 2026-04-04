import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { defineCommand } from 'citty'
import { ProjectExistsError } from '../../errors'
import { PACKAGE_MANAGERS, TEMPLATES, TEMPLATE_INFO } from '../../types'
import type { PackageManager, TemplateName } from '../../types'
import { directoryExists } from '../../utils/fs-helpers'
import { createLogger } from '../../utils/logger'
import {
	detectPackageManager,
	getInstallCommand,
	getRunDevCommand,
} from '../../utils/package-manager'
import { promptSelect, promptText } from '../../utils/prompt'
import { scaffoldTemplate } from './template-engine'

/**
 * The `create` command — scaffolds a new Kora project.
 * Used as `kora create <name>` or `create-kora-app <name>`.
 */
export const createCommand = defineCommand({
	meta: {
		name: 'create',
		description: 'Create a new Kora application',
	},
	args: {
		name: {
			type: 'positional',
			description: 'Project directory name',
			required: false,
		},
		template: {
			type: 'string',
			description: 'Project template (react-basic, react-sync)',
		},
		pm: {
			type: 'string',
			description: 'Package manager (pnpm, npm, yarn, bun)',
		},
		'skip-install': {
			type: 'boolean',
			description: 'Skip installing dependencies',
			default: false,
		},
	},
	async run({ args }) {
		const logger = createLogger()
		logger.banner()

		// Resolve project name
		const projectName = args.name || (await promptText('Project name', 'my-kora-app'))
		if (!projectName) {
			logger.error('Project name is required')
			process.exitCode = 1
			return
		}

		// Resolve template
		let template: TemplateName
		if (args.template && isValidTemplate(args.template)) {
			template = args.template
		} else {
			template = await promptSelect(
				'Select a template:',
				TEMPLATE_INFO.map((t) => ({ label: `${t.label} — ${t.description}`, value: t.name })),
			)
		}

		// Resolve package manager
		let pm: PackageManager
		if (args.pm && isValidPackageManager(args.pm)) {
			pm = args.pm
		} else {
			const detected = detectPackageManager()
			pm = await promptSelect(
				'Package manager:',
				PACKAGE_MANAGERS.map((p) => ({
					label: p === detected ? `${p} (detected)` : p,
					value: p,
				})),
			)
		}

		// Validate target directory
		const targetDir = resolve(process.cwd(), projectName)
		if (await directoryExists(targetDir)) {
			throw new ProjectExistsError(projectName)
		}

		// Scaffold
		logger.step(`Creating ${projectName} with ${template} template...`)
		await scaffoldTemplate(template, targetDir, {
			projectName,
			packageManager: pm,
			koraVersion: '0.0.0',
		})
		logger.success('Project scaffolded')

		// Install dependencies
		if (!args['skip-install']) {
			logger.step('Installing dependencies...')
			try {
				execSync(getInstallCommand(pm), { cwd: targetDir, stdio: 'inherit' })
				logger.success('Dependencies installed')
			} catch {
				logger.warn('Failed to install dependencies. Run install manually.')
			}
		}

		// Print next steps
		logger.blank()
		logger.info('Done! Next steps:')
		logger.blank()
		logger.step(`  cd ${projectName}`)
		logger.step(`  ${getRunDevCommand(pm)}`)
		logger.blank()
	},
})

function isValidTemplate(value: string): value is TemplateName {
	return (TEMPLATES as readonly string[]).includes(value)
}

function isValidPackageManager(value: string): value is PackageManager {
	return (PACKAGE_MANAGERS as readonly string[]).includes(value)
}
