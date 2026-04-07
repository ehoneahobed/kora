import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineCommand } from 'citty'
import { createPromptClient, PromptCancelledError } from '../../prompts/prompt-client'
import { PreferenceStore } from '../../prompts/preferences'
import { ProjectExistsError } from '../../errors'
import { PACKAGE_MANAGERS, TEMPLATES } from '../../types'
import type { PackageManager, TemplateName } from '../../types'
import { directoryExists } from '../../utils/fs-helpers'
import { createLogger } from '../../utils/logger'
import { detectPackageManager, getInstallCommand, getRunDevCommand } from '../../utils/package-manager'
import { validateProjectName } from './project-name'
import {
	resolveCreatePreferencesFlow,
	saveResolvedPreferences,
	shouldSavePreferences,
	type CreateFlags,
} from './preferences-flow'
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
			description:
				'Project template (react-tailwind-sync, react-tailwind, react-sync, react-basic)',
		},
		pm: {
			type: 'string',
			description: 'Package manager (pnpm, npm, yarn, bun)',
		},
		framework: {
			type: 'string',
			description: 'UI framework (react, vue, svelte, solid)',
		},
		db: {
			type: 'string',
			description: 'Database backend for sync templates (sqlite, postgres)',
		},
		'db-provider': {
			type: 'string',
			description: 'Database provider for postgres (local, supabase, neon, railway, vercel-postgres, custom)',
		},
		auth: {
			type: 'string',
			description: 'Authentication mode (none, email-password, oauth)',
		},
		'skip-install': {
			type: 'boolean',
			description: 'Skip installing dependencies',
			default: false,
		},
		yes: {
			type: 'boolean',
			alias: 'y',
			description: 'Accept all defaults (react-tailwind-sync + detected package manager)',
			default: false,
		},
		tailwind: {
			type: 'boolean',
			description: 'Use Tailwind CSS (use --no-tailwind to skip)',
		},
		sync: {
			type: 'boolean',
			description: 'Include sync server (use --no-sync to skip)',
		},
	},
	async run({ args }) {
		const logger = createLogger()
		const prompts = createPromptClient()
		const preferenceStore = new PreferenceStore()
		logger.banner()
		try {
			const useDefaults = args.yes === true
			if (!useDefaults) {
				prompts.intro('Kora.js — Offline-first application framework')
			}

			// Resolve project name
			const projectName =
				args.name || (useDefaults ? 'my-kora-app' : await prompts.text('Project name', 'my-kora-app'))
			if (!projectName) {
				logger.error('Project name is required')
				process.exitCode = 1
				return
			}
			const nameValidation = validateProjectName(projectName)
			if (!nameValidation.valid) {
				logger.error('Invalid project name.')
				for (const issue of nameValidation.issues) {
					logger.step(`- ${issue}`)
				}
				if (!useDefaults) {
					prompts.outro('Project creation aborted.')
				}
				process.exitCode = 1
				return
			}

			const preferenceFlags: CreateFlags = {
				framework: typeof args.framework === 'string' ? args.framework : undefined,
				auth: typeof args.auth === 'string' ? args.auth : undefined,
				db: typeof args.db === 'string' ? args.db : undefined,
				dbProvider: typeof args['db-provider'] === 'string' ? args['db-provider'] : undefined,
				tailwind: args.tailwind,
				sync: args.sync,
				useDefaults,
			}

			const selection = await resolveCreatePreferencesFlow({
				flags: preferenceFlags,
				prompts,
				store: preferenceStore,
			})
			if (selection.framework !== 'react') {
				logger.error(`Framework "${selection.framework}" is not available yet. Use "react".`)
				if (!useDefaults) {
					prompts.outro('Project creation aborted.')
				}
				process.exitCode = 1
				return
			}
			if (selection.auth !== 'none') {
				logger.error(`Auth mode "${selection.auth}" is not available yet. Use "none".`)
				if (!useDefaults) {
					prompts.outro('Project creation aborted.')
				}
				process.exitCode = 1
				return
			}

			// Resolve template (explicit --template still overrides all selections).
			const template: TemplateName =
				args.template && isValidTemplate(args.template) ? args.template : selection.template

			// Resolve package manager
			let pm: PackageManager
			if (args.pm && isValidPackageManager(args.pm)) {
				pm = args.pm
			} else if (useDefaults) {
				pm = detectPackageManager()
			} else if (selection.usedStoredPreferences) {
				pm = preferenceStore.getCreatePreferences()?.packageManager ?? detectPackageManager()
			} else {
				const detected = detectPackageManager()
				pm = await prompts.select(
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

			// Resolve kora version from this package's own package.json
			const koraVersion = resolveKoraVersion()

			// Scaffold
			logger.step(`Creating ${projectName} with ${template} template...`)
			await scaffoldTemplate(template, targetDir, {
				projectName,
				packageManager: pm,
				koraVersion,
			})
			logger.success('Project scaffolded')

			if (shouldSavePreferences(preferenceFlags)) {
				saveResolvedPreferences(preferenceStore, {
					framework: selection.framework,
					auth: selection.auth,
					db: selection.db,
					dbProvider: selection.dbProvider,
					tailwind: selection.tailwind,
					sync: selection.sync,
					packageManager: pm,
				})
			}

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
			if (!useDefaults) {
				prompts.outro('Project ready. Happy building with Kora!')
			}
		} catch (error) {
			if (error instanceof PromptCancelledError) {
				process.exitCode = 1
				return
			}
			if (error instanceof Error && error.message.startsWith('Invalid --')) {
				logger.error(error.message)
				if (!args.yes) {
					prompts.outro('Project creation aborted.')
				}
				process.exitCode = 1
				return
			}
			throw error
		}
	},
})

function isValidTemplate(value: string): value is TemplateName {
	return (TEMPLATES as readonly string[]).includes(value)
}

function isValidPackageManager(value: string): value is PackageManager {
	return (PACKAGE_MANAGERS as readonly string[]).includes(value)
}

/**
 * Reads the version from @korajs/cli's own package.json and derives a
 * compatible version range for all @korajs packages.
 *
 * The CLI may be a patch ahead of other packages (e.g. CLI-only fixes),
 * so we use the major.minor range (^major.minor.0) which matches all
 * packages in the same release series.
 */
function resolveKoraVersion(): string {
	try {
		let dir = dirname(fileURLToPath(import.meta.url))
		for (let i = 0; i < 5; i++) {
			const pkgPath = resolve(dir, 'package.json')
			if (existsSync(pkgPath)) {
				const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version: string }
				if (pkg.name === '@korajs/cli') {
					if (pkg.version === '0.0.0') return 'latest'
					// Use ^major.minor.0 so all packages in the series match
					const parts = pkg.version.split('.')
					return `^${parts[0]}.${parts[1]}.0`
				}
			}
			dir = dirname(dir)
		}
		return 'latest'
	} catch {
		return 'latest'
	}
}
