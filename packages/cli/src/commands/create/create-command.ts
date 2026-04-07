import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { createPromptClient } from '../../prompts/prompt-client'
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
		logger.banner()

		const useDefaults = args.yes === true

		// Resolve project name
		const projectName =
			args.name || (useDefaults ? 'my-kora-app' : await prompts.text('Project name', 'my-kora-app'))
		if (!projectName) {
			logger.error('Project name is required')
			process.exitCode = 1
			return
		}

		// Resolve template
		let template: TemplateName
		if (args.template && isValidTemplate(args.template)) {
			// Explicit --template flag takes priority
			template = args.template
		} else if (useDefaults) {
			// --yes defaults to recommended template
			template = 'react-tailwind-sync'
		} else if (args.tailwind !== undefined || args.sync !== undefined) {
			// Derive template from --tailwind and --sync flags
			template = resolveTemplateFromFlags(args.tailwind, args.sync)
		} else {
			template = await prompts.select(
				'Select a template:',
				TEMPLATE_INFO.map((t) => ({ label: `${t.label} — ${t.description}`, value: t.name })),
			)
		}

		// Resolve package manager
		let pm: PackageManager
		if (args.pm && isValidPackageManager(args.pm)) {
			pm = args.pm
		} else if (useDefaults) {
			pm = detectPackageManager()
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

/**
 * Derives the template name from --tailwind and --sync boolean flags.
 * Unspecified flags default to true (tailwind and sync are the recommended defaults).
 */
function resolveTemplateFromFlags(
	tailwind: boolean | undefined,
	sync: boolean | undefined,
): TemplateName {
	const useTailwind = tailwind !== false
	const useSync = sync !== false
	if (useTailwind && useSync) return 'react-tailwind-sync'
	if (useTailwind && !useSync) return 'react-tailwind'
	if (!useTailwind && useSync) return 'react-sync'
	return 'react-basic'
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
