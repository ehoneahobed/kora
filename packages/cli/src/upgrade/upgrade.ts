import { access } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { UpgradeError } from '../errors'
import type { PackageManager } from '../types'
import type { Logger } from '../utils/logger'
import { applyUpgradeChanges } from './apply'
import { applyCodemodEdits, runCodemods } from './codemods/registry'
import type { CodemodRunSummary } from './codemods/registry'
import { readSourceFiles } from './codemods/source-files'
import { buildUpgradePlan, classifySpecifiers } from './plan'
import type { UpgradePlan } from './plan'
import { inspectProject } from './project'
import type { KoraProject } from './project'
import { isUpgradeTag, resolveTargetVersion } from './registry'
import type { RegistryLookup } from './registry'
import { type CommandRunner, installInvocation, koraBinInvocation } from './runner'

export interface UpgradeOptions {
	/** Directory containing the project's package.json. */
	projectRoot: string
	/** `--tag`: `latest`, `beta` or `canary`. */
	tag?: string
	/** `--to`: an exact version. */
	to?: string
	/** Print the plan and diagnostics; change nothing and run nothing. */
	dryRun: boolean
	/** Skip the confirmation prompt. */
	yes: boolean
	/** Allow moving to a version older than the one installed. */
	allowDowngrade: boolean
	/** Apply codemod edits that are safe and unambiguous (none of the built-in ones rewrite). */
	applyCodemods: boolean
	/** True when a person can answer a prompt (a TTY). */
	interactive: boolean
}

/** Everything `runUpgrade` touches outside the project files, injected so tests stay offline. */
export interface UpgradeDependencies {
	lookup: RegistryLookup
	runCommand: CommandRunner
	confirm: (message: string) => Promise<boolean>
	logger: Logger
	/** Package manager used when neither package.json nor a lockfile names one. */
	fallbackPackageManager: PackageManager
	/**
	 * Whether the project has a `kora` binary after install, given the directories to look in.
	 * Defaults to checking `node_modules/.bin/kora`; injected so tests need no node_modules.
	 */
	hasKoraBinary?: (directories: string[]) => Promise<boolean>
}

function relativeTo(root: string, file: string): string {
	return relative(root, file) || file
}

/** Plug'n'Play installs have no node_modules/.bin, so absence there proves nothing. */
async function defaultHasKoraBinary(directories: string[]): Promise<boolean> {
	for (const directory of directories) {
		for (const candidate of [
			join(directory, 'node_modules', '.bin', 'kora'),
			join(directory, 'node_modules', '.bin', 'kora.cmd'),
			join(directory, '.pnp.cjs'),
		]) {
			try {
				await access(candidate)
				return true
			} catch {
				// Not here; try the next candidate.
			}
		}
	}
	return false
}

function addDevCommand(pm: PackageManager, version: string): string {
	return `${pm} ${pm === 'npm' ? 'install --save-dev' : 'add -D'} @korajs/cli@${version}`
}

/** Runs a command; a spawn failure (binary missing) becomes an UpgradeError, not a stack trace. */
async function runOrFail(
	run: CommandRunner,
	command: string,
	args: string[],
	cwd: string,
	code: string,
	message: string,
): Promise<number> {
	try {
		return await run(command, args, cwd)
	} catch (error) {
		throw new UpgradeError(
			`${message}: ${error instanceof Error ? error.message : String(error)}`,
			code,
			{ command },
		)
	}
}

export interface UpgradeResult {
	status: 'dry-run' | 'up-to-date' | 'cancelled' | 'upgraded'
	project: KoraProject
	plan: UpgradePlan
	codemods: CodemodRunSummary[]
}

function describeLocation(
	specifier:
		| UpgradePlan['changes'][number]['specifier']
		| UpgradePlan['skipped'][number]['specifier'],
	projectRoot: string,
): string {
	return `${relativeTo(projectRoot, specifier.file)} ${specifier.section}`
}

function printPlan(plan: UpgradePlan, project: KoraProject, logger: Logger): void {
	const source = plan.target.source === 'tag' ? `dist-tag ${plan.target.tag}` : '--to'
	logger.info(
		`Upgrading ${plan.packageNames.length} Kora package(s) to ${plan.target.version} (${source}) with ${project.packageManager}`,
	)
	for (const warning of project.warnings) logger.warn(warning)
	for (const change of plan.changes) {
		logger.step(
			`${change.specifier.name}  ${change.from} -> ${change.to}  (${describeLocation(change.specifier, project.root)})`,
		)
	}
	for (const entry of plan.unchanged) {
		logger.step(
			`${entry.specifier.name}  ${entry.specifier.spec} (already on ${plan.target.version}; ${describeLocation(entry.specifier, project.root)})`,
		)
	}
	for (const skipped of plan.skipped) {
		logger.step(
			`${skipped.specifier.name}  ${skipped.specifier.spec} left as is: ${skipped.reason} (${describeLocation(skipped.specifier, project.root)})`,
		)
	}
	for (const warning of plan.warnings) logger.warn(warning)
}

function printCodemods(summaries: CodemodRunSummary[], logger: Logger): void {
	const total = summaries.reduce((sum, summary) => sum + summary.findings.length, 0)
	if (summaries.length === 0) return
	logger.blank()
	if (total === 0) {
		logger.success(`Upgrade diagnostics: nothing to review (${summaries.length} check(s) ran).`)
		return
	}
	logger.info('Upgrade diagnostics (report only; nothing was rewritten):')
	for (const { codemod, findings } of summaries) {
		if (findings.length === 0) continue
		logger.step(`${codemod.title} [${codemod.id}]`)
		for (const finding of findings) {
			const line = `${finding.file}:${finding.line}  ${finding.message}`
			if (finding.severity === 'warn') logger.warn(line)
			else logger.step(`  ${line}`)
		}
		logger.step(`  More: ${codemod.docs}`)
	}
}

/**
 * Upgrades every Kora package in a project to one version, then verifies it.
 *
 * 1. Inspect the project: package manager, every `korajs` / `@korajs/*` specifier in
 *    dependencies, devDependencies, optionalDependencies, overrides, resolutions and pnpm catalogs.
 * 2. Resolve one target version from the registry (a dist-tag or `--to`).
 * 3. Print the plan and the upgrade diagnostics. With `dryRun` it stops here.
 * 4. Rewrite the specifiers (each keeps its `^` / `~` / exact style), run the package
 *    manager's install, then run `kora doctor` from the upgraded CLI.
 *
 * Lockfiles and node_modules are never written directly.
 *
 * @throws UpgradeError when nothing can be upgraded safely, or when install or doctor fails.
 */
export async function runUpgrade(
	options: UpgradeOptions,
	deps: UpgradeDependencies,
): Promise<UpgradeResult> {
	const { logger } = deps
	if (options.to !== undefined && options.tag !== undefined) {
		throw new UpgradeError('Pass either --tag or --to, not both.', 'UPGRADE_CONFLICTING_FLAGS')
	}
	if (options.tag !== undefined && !isUpgradeTag(options.tag)) {
		throw new UpgradeError(
			`Unknown --tag "${options.tag}". Use latest, beta or canary, or --to <version>.`,
			'UPGRADE_INVALID_TAG',
			{ tag: options.tag },
		)
	}

	const project = await inspectProject(options.projectRoot, deps.fallbackPackageManager)
	const classified = classifySpecifiers(project.specifiers)
	if (classified.bumpable.length === 0) {
		throw new UpgradeError(
			'No Kora package with a registry version found in package.json or the pnpm catalog. Nothing to upgrade.',
			'UPGRADE_NO_PACKAGES',
		)
	}

	const names = [...new Set(classified.bumpable.map((entry) => entry.specifier.name))].sort()
	const target = await resolveTargetVersion({
		packageNames: names,
		lookup: deps.lookup,
		...(options.tag !== undefined && isUpgradeTag(options.tag) ? { tag: options.tag } : {}),
		...(options.to !== undefined ? { to: options.to } : {}),
		currentVersions: classified.bumpable.map((entry) => entry.version),
	})
	const plan = buildUpgradePlan(classified, target, { allowDowngrade: options.allowDowngrade })

	logger.banner()
	printPlan(plan, project, logger)

	const files = await readSourceFiles(project.root)
	const codemods = runCodemods({
		projectRoot: project.root,
		files,
		fromVersion: plan.currentVersion,
		toVersion: target.version,
	})
	printCodemods(codemods, logger)

	if (options.dryRun) {
		logger.blank()
		logger.info('Dry run: nothing was changed, no install, no doctor.')
		return { status: 'dry-run', project, plan, codemods }
	}
	if (plan.changes.length === 0) {
		logger.blank()
		logger.success(`Every Kora package is already on ${target.version}.`)
		return { status: 'up-to-date', project, plan, codemods }
	}

	if (!options.yes) {
		if (!options.interactive) {
			throw new UpgradeError(
				'Refusing to change files without confirmation in a non-interactive shell. Re-run with --yes, or --dry-run to preview.',
				'UPGRADE_CONFIRMATION_REQUIRED',
			)
		}
		logger.blank()
		if (
			!(await deps.confirm(
				`Apply ${plan.changes.length} change(s) and run ${project.packageManager} install?`,
			))
		) {
			logger.info('Cancelled. Nothing was changed.')
			return { status: 'cancelled', project, plan, codemods }
		}
	}

	// Every file this run changes, for the restore hint if a later step fails.
	const modified: string[] = []
	const restoreHint = (): string =>
		`Modified: ${modified.map((file) => relativeTo(project.root, file)).join(', ')}. Restore with \`git checkout -- ${modified.map((file) => relativeTo(project.root, file)).join(' ')}\` (or revert them by hand).`

	const written = await applyUpgradeChanges(plan.changes)
	for (const file of written) {
		modified.push(file)
		logger.success(`Updated ${file}`)
	}

	const edits = codemods.flatMap((summary) => summary.edits)
	if (edits.length > 0) {
		if (options.applyCodemods) {
			let result: Awaited<ReturnType<typeof applyCodemodEdits>>
			try {
				result = await applyCodemodEdits(project.root, files, edits)
			} catch (error) {
				throw new UpgradeError(
					`Applying codemod edits failed (${error instanceof Error ? error.message : String(error)}). ${restoreHint()}`,
					'UPGRADE_CODEMOD_FAILED',
					{ modified },
				)
			}
			for (const path of result.written) {
				modified.push(join(project.root, path))
				logger.success(`Codemod rewrote ${path}`)
			}
			for (const path of result.skipped) {
				logger.warn(
					`Codemod edits for ${path} were not applied (overlap or the file changed). Review it by hand.`,
				)
			}
		} else {
			logger.info(
				`${edits.length} safe codemod edit(s) are available; re-run with --apply-codemods.`,
			)
		}
	}

	const install = installInvocation(project.packageManager)
	logger.blank()
	logger.info(`Running ${install.command} ${install.args.join(' ')} in ${project.installDir}`)
	const installCode = await runOrFail(
		deps.runCommand,
		install.command,
		install.args,
		project.installDir,
		'UPGRADE_INSTALL_FAILED',
		`${install.command} could not be started`,
	)
	if (installCode !== 0) {
		throw new UpgradeError(
			`${install.command} install failed (exit ${installCode}). The project files already point at ${target.version}: fix the install error and re-run \`${install.command} install\`, or restore them. ${restoreHint()}`,
			'UPGRADE_INSTALL_FAILED',
			{ exitCode: installCode, packageManager: project.packageManager, modified },
		)
	}

	// The doctor must be the upgraded CLI, not the older one running this process.
	const hasBinary = await (deps.hasKoraBinary ?? defaultHasKoraBinary)([
		project.root,
		project.installDir,
	])
	if (!hasBinary) {
		throw new UpgradeError(
			`The upgrade is installed, but the kora binary is not in this project, so kora doctor could not run. Add the CLI with \`${addDevCommand(project.packageManager, target.version)}\`, then run \`kora doctor\`.`,
			'UPGRADE_DOCTOR_UNAVAILABLE',
		)
	}
	const doctor = koraBinInvocation(project.packageManager, ['doctor', '--skip-network'])
	logger.blank()
	logger.info('Running kora doctor')
	const doctorCode = await runOrFail(
		deps.runCommand,
		doctor.command,
		doctor.args,
		project.root,
		'UPGRADE_DOCTOR_UNAVAILABLE',
		`kora doctor could not be started (add the CLI with \`${addDevCommand(project.packageManager, target.version)}\`)`,
	)
	if (doctorCode !== 0) {
		throw new UpgradeError(
			`kora doctor reported blocking issues after the upgrade (exit ${doctorCode}). The packages are on ${target.version}; fix what doctor listed above, then re-run \`kora doctor\`.`,
			'UPGRADE_DOCTOR_FAILED',
			{ exitCode: doctorCode },
		)
	}

	logger.blank()
	logger.success(`Upgraded to ${target.version}.`)
	return { status: 'upgraded', project, plan, codemods }
}
