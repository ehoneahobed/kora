import { defineCommand } from 'citty'
import { InvalidProjectError, UpgradeError } from '../../errors'
import { createHttpRegistryLookup } from '../../upgrade/registry'
import { spawnCommandRunner } from '../../upgrade/runner'
import { runUpgrade } from '../../upgrade/upgrade'
import { findProjectRoot } from '../../utils/fs-helpers'
import { createLogger } from '../../utils/logger'
import { detectPackageManager } from '../../utils/package-manager'
import { promptConfirm } from '../../utils/prompt'

/**
 * Bump every Kora package in the project to one version, install, report upgrade
 * diagnostics, and run `kora doctor`.
 */
export const upgradeCommand = defineCommand({
	meta: {
		name: 'upgrade',
		description:
			'Upgrade every Kora package to one version, run the install, flag changed APIs, then run kora doctor',
	},
	args: {
		tag: {
			type: 'string',
			description:
				'Registry dist-tag to upgrade to: latest, beta or canary (default: beta when you are on a prerelease, else latest)',
		},
		to: {
			type: 'string',
			description: 'Exact version to upgrade to, e.g. 1.0.0-beta.15 (instead of --tag)',
		},
		'dry-run': {
			type: 'boolean',
			description: 'Print the plan and the upgrade diagnostics; change nothing, install nothing',
			default: false,
		},
		yes: {
			type: 'boolean',
			description: 'Do not ask for confirmation',
			default: false,
		},
		'allow-downgrade': {
			type: 'boolean',
			description: 'Allow a target older than the installed version',
			default: false,
		},
		'apply-codemods': {
			type: 'boolean',
			description:
				'Apply codemod edits that are safe and unambiguous (diagnostics never rewrite otherwise)',
			default: false,
		},
	},
	async run({ args }) {
		const logger = createLogger()
		const projectRoot = await findProjectRoot()
		if (!projectRoot) {
			throw new InvalidProjectError(process.cwd())
		}

		try {
			await runUpgrade(
				{
					projectRoot,
					...(typeof args.tag === 'string' ? { tag: args.tag } : {}),
					...(typeof args.to === 'string' ? { to: args.to } : {}),
					dryRun: args['dry-run'] === true,
					yes: args.yes === true,
					allowDowngrade: args['allow-downgrade'] === true,
					applyCodemods: args['apply-codemods'] === true,
					interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
				},
				{
					lookup: createHttpRegistryLookup(),
					runCommand: spawnCommandRunner,
					confirm: (message) => promptConfirm(message, true),
					logger,
					fallbackPackageManager: detectPackageManager(),
				},
			)
		} catch (error) {
			if (error instanceof UpgradeError) {
				logger.blank()
				logger.error(error.message)
				process.exitCode = 1
				return
			}
			throw error
		}
	},
})
