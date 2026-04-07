import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineCommand } from 'citty'
import { ProjectExistsError } from '../../errors'
import { PACKAGE_MANAGERS, TEMPLATES, TEMPLATE_INFO } from '../../types'
import type { PackageManager, TemplateName } from '../../types'
import type { SelectOption } from '../../prompts/prompt-client'
import { directoryExists } from '../../utils/fs-helpers'
import { createLogger } from '../../utils/logger'
import {
	detectPackageManager,
	getInstallCommand,
	getRunDevCommand,
} from '../../utils/package-manager'
import { createPromptClient, PromptCancelledError } from '../../prompts/prompt-client'
import { validateProjectName } from './project-name'
import {
	determineTemplateFromSelections,
	isAuthValue,
	isDatabaseProviderValue,
	isDatabaseValue,
	isFrameworkValue,
	type AuthOption,
	type DatabaseOption,
	type DatabaseProviderOption,
	type FrameworkOption,
} from './options'
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

			const selectedFramework = await resolveFrameworkSelection(
				typeof args.framework === 'string' ? args.framework : undefined,
				useDefaults,
				prompts,
			)
			if (selectedFramework !== 'react') {
				logger.error(`Framework "${selectedFramework}" is not available yet. Use "react".`)
				if (!useDefaults) {
					prompts.outro('Project creation aborted.')
				}
				process.exitCode = 1
				return
			}

			const selectedAuth = await resolveAuthSelection(
				typeof args.auth === 'string' ? args.auth : undefined,
				useDefaults,
				prompts,
			)
			if (selectedAuth !== 'none') {
				logger.error(`Auth mode "${selectedAuth}" is not available yet. Use "none".`)
				if (!useDefaults) {
					prompts.outro('Project creation aborted.')
				}
				process.exitCode = 1
				return
			}

			const selectedDb = await resolveDatabaseSelection(
				typeof args.db === 'string' ? args.db : undefined,
				args.sync,
				useDefaults,
				prompts,
			)
			const selectedDbProvider = await resolveDatabaseProviderSelection(
				typeof args['db-provider'] === 'string' ? args['db-provider'] : undefined,
				selectedDb,
				useDefaults,
				prompts,
			)

			// Resolve template
			let template: TemplateName
			if (args.template && isValidTemplate(args.template)) {
				// Explicit --template flag takes priority
				template = args.template
			} else if (args.tailwind !== undefined || args.sync !== undefined) {
				// Derive template from --tailwind and --sync flags
				template = resolveTemplateFromFlags(args.tailwind, args.sync)
			} else if (useDefaults) {
				// --yes defaults to recommended template
				template = 'react-tailwind-sync'
			} else {
				const selectedTailwind = await prompts.confirm('Use Tailwind CSS?', true)
				template = resolveTemplateFromSelections({
					tailwind: selectedTailwind,
					sync: selectedDb !== 'none',
					db: selectedDb,
				})
			}

			// This value is intentionally unused for now.
			// Phase 12 template composition will consume provider-specific layers.
			void selectedDbProvider

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
			if (!useDefaults) {
				prompts.outro('Project ready. Happy building with Kora!')
			}
		} catch (error) {
			if (error instanceof PromptCancelledError) {
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

async function resolveFrameworkSelection(
	flagFramework: string | undefined,
	useDefaults: boolean,
	prompts: {
		select<T extends string>(message: string, options: readonly SelectOption<T>[]): Promise<T>
	},
): Promise<FrameworkOption> {
	if (flagFramework !== undefined) {
		if (!isFrameworkValue(flagFramework)) {
			throw new Error(`Invalid --framework value "${flagFramework}". Expected one of: react, vue, svelte, solid.`)
		}
		return flagFramework
	}
	if (useDefaults) {
		return 'react'
	}
	return prompts.select('UI framework:', [
		{ label: 'React', value: 'react' },
		{ label: 'Vue (coming soon)', value: 'vue', disabled: true },
		{ label: 'Svelte (coming soon)', value: 'svelte', disabled: true },
		{ label: 'Solid (coming soon)', value: 'solid', disabled: true },
	])
}

async function resolveAuthSelection(
	flagAuth: string | undefined,
	useDefaults: boolean,
	prompts: {
		select<T extends string>(message: string, options: readonly SelectOption<T>[]): Promise<T>
	},
): Promise<AuthOption> {
	if (flagAuth !== undefined) {
		if (!isAuthValue(flagAuth)) {
			throw new Error(
				`Invalid --auth value "${flagAuth}". Expected one of: none, email-password, oauth.`,
			)
		}
		return flagAuth
	}
	if (useDefaults) {
		return 'none'
	}
	return prompts.select('Authentication:', [
		{ label: 'None', value: 'none' },
		{ label: 'Email + Password (coming soon)', value: 'email-password', disabled: true },
		{ label: 'OAuth (coming soon)', value: 'oauth', disabled: true },
	])
}

async function resolveDatabaseSelection(
	flagDb: string | undefined,
	syncFlag: boolean | undefined,
	useDefaults: boolean,
	prompts: {
		confirm(message: string, defaultValue?: boolean): Promise<boolean>
		select<T extends string>(message: string, options: readonly SelectOption<T>[]): Promise<T>
	},
): Promise<DatabaseOption> {
	if (flagDb !== undefined) {
		if (!isDatabaseValue(flagDb)) {
			throw new Error(`Invalid --db value "${flagDb}". Expected one of: none, sqlite, postgres.`)
		}
		return flagDb
	}

	const syncEnabled = syncFlag ?? (useDefaults ? true : await prompts.confirm('Enable multi-device sync?', true))
	if (!syncEnabled) {
		return 'none'
	}

	if (useDefaults) {
		return 'sqlite'
	}

	return prompts.select('Server-side database:', [
		{ label: 'SQLite (zero-config)', value: 'sqlite' },
		{ label: 'PostgreSQL (production-scale)', value: 'postgres' },
	])
}

async function resolveDatabaseProviderSelection(
	flagProvider: string | undefined,
	db: DatabaseOption,
	useDefaults: boolean,
	prompts: {
		select<T extends string>(message: string, options: readonly SelectOption<T>[]): Promise<T>
	},
): Promise<DatabaseProviderOption> {
	if (flagProvider !== undefined) {
		if (!isDatabaseProviderValue(flagProvider)) {
			throw new Error(
				`Invalid --db-provider value "${flagProvider}". Expected one of: none, local, supabase, neon, railway, vercel-postgres, custom.`,
			)
		}
		return flagProvider
	}

	if (db !== 'postgres') {
		return 'none'
	}
	if (useDefaults) {
		return 'local'
	}

	return prompts.select('Database provider:', [
		{ label: 'Local Postgres', value: 'local' },
		{ label: 'Supabase', value: 'supabase' },
		{ label: 'Neon', value: 'neon' },
		{ label: 'Railway', value: 'railway' },
		{ label: 'Vercel Postgres', value: 'vercel-postgres' },
		{ label: 'Custom connection string', value: 'custom' },
	])
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
