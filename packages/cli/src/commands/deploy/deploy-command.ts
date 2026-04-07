import { basename, join } from 'node:path'
import { defineCommand } from 'citty'
import { InvalidProjectError } from '../../errors'
import { createPromptClient } from '../../prompts/prompt-client'
import { findProjectRoot } from '../../utils/fs-helpers'
import { createLogger } from '../../utils/logger'
import { DEPLOY_PLATFORMS, type DeployPlatform, isDeployPlatform } from './adapters/adapter'
import {
	writeDockerIgnoreArtifact,
	writeDockerfileArtifact,
} from './artifacts/dockerfile-generator'
import { writeFlyTomlArtifact } from './artifacts/fly-toml-generator'
import { buildClient } from './builder/client-builder'
import { bundleServer } from './builder/server-bundler'
import {
	readDeployState,
	resetDeployState,
	resolveDeployDirectory,
	updateDeployState,
	writeDeployState,
} from './state/deploy-state'

/**
 * The `deploy` command scaffold for Phase 13.
 *
 * This command currently performs the foundational deployment workflow:
 * - resolves/stores deployment state
 * - generates deterministic deploy artifacts
 * - builds the client and prepares a server bundle placeholder
 *
 * Platform-specific provisioning/deployment adapters are wired in subsequent
 * Phase 13 iterations.
 */
export const deployCommand = defineCommand({
	meta: {
		name: 'deploy',
		description: 'Deploy a Kora project to your selected platform',
	},
	args: {
		platform: {
			type: 'string',
			description: `Deployment platform (${DEPLOY_PLATFORMS.join(', ')})`,
		},
		app: {
			type: 'string',
			description: 'Application name used by the target platform',
		},
		region: {
			type: 'string',
			description: 'Preferred deployment region (for example: iad, lhr, syd)',
		},
		prod: {
			type: 'boolean',
			description: 'Deploy to production environment',
			default: false,
		},
		confirm: {
			type: 'boolean',
			description: 'Non-interactive mode (fail fast on missing required data)',
			default: false,
		},
		reset: {
			type: 'boolean',
			description: 'Delete .kora/deploy state and generated artifacts',
			default: false,
		},
	},
	subCommands: {
		status: defineCommand({
			meta: {
				name: 'status',
				description: 'Show current local deploy state',
			},
			async run() {
				const logger = createLogger()
				const projectRoot = await requireProjectRoot()
				const state = await readDeployState(projectRoot)
				if (!state) {
					logger.warn('No deployment state found. Run `kora deploy` first.')
					return
				}

				logger.banner()
				logger.info(`Platform: ${state.platform}`)
				logger.step(`App: ${state.appName}`)
				logger.step(`Region: ${state.region ?? 'n/a'}`)
				logger.step(`Last deployment: ${state.lastDeploymentId ?? 'n/a'}`)
				logger.step(`Live URL: ${state.liveUrl ?? 'n/a'}`)
				logger.step(`Sync URL: ${state.syncUrl ?? 'n/a'}`)
			},
		}),
		rollback: defineCommand({
			meta: {
				name: 'rollback',
				description: 'Rollback command stub (adapter wiring pending)',
			},
			args: {
				id: {
					type: 'positional',
					description: 'Optional deployment identifier',
					required: false,
				},
			},
			async run({ args }) {
				const logger = createLogger()
				const projectRoot = await requireProjectRoot()
				const state = await readDeployState(projectRoot)
				if (!state) {
					logger.warn('No deployment state found. Run `kora deploy` first.')
					return
				}

				const deploymentId =
					typeof args.id === 'string' && args.id.length > 0
						? args.id
						: (state.lastDeploymentId ?? 'latest')
				logger.warn(
					`Rollback support for "${state.platform}" is not wired yet. Planned target deployment: ${deploymentId}.`,
				)
			},
		}),
		logs: defineCommand({
			meta: {
				name: 'logs',
				description: 'Log streaming stub (adapter wiring pending)',
			},
			async run() {
				const logger = createLogger()
				const projectRoot = await requireProjectRoot()
				const state = await readDeployState(projectRoot)
				if (!state) {
					logger.warn('No deployment state found. Run `kora deploy` first.')
					return
				}
				logger.warn(`Log streaming for "${state.platform}" is not wired yet.`)
			},
		}),
	},
	async run({ args }) {
		const logger = createLogger()
		const prompts = createPromptClient()
		const projectRoot = await requireProjectRoot()

		if (args.reset === true) {
			await resetDeployState(projectRoot)
			logger.success('Reset .kora/deploy state.')
			return
		}

		const existingState = await readDeployState(projectRoot)
		const platform = await resolvePlatform({
			promptClient: prompts,
			platformArg: args.platform,
			storedPlatform: existingState?.platform,
			confirm: args.confirm === true,
		})
		const appName = resolveAppName(args.app, existingState?.appName, projectRoot)
		const region = resolveRegion(args.region, existingState?.region)
		const deployDirectory = resolveDeployDirectory(projectRoot)
		const clientOutputDirectory = join(deployDirectory, 'dist')
		const environment = args.prod === true ? 'production' : 'preview'

		logger.banner()
		logger.info(
			`Preparing deploy artifacts for ${platform} (${appName}${region ? `, ${region}` : ''}, ${environment})`,
		)

		await writeDockerfileArtifact(deployDirectory)
		await writeDockerIgnoreArtifact(deployDirectory)
		if (platform === 'fly') {
			await writeFlyTomlArtifact(deployDirectory, {
				appName,
				region: region ?? 'iad',
			})
		}
		await bundleServer({
			projectRoot,
			deployDirectory,
		})
		await buildClient({
			projectRoot,
			outDir: clientOutputDirectory,
			mode: 'production',
		})

		if (existingState) {
			await updateDeployState(projectRoot, {
				platform,
				appName,
				region,
				projectRoot,
			})
		} else {
			await writeDeployState(projectRoot, {
				platform,
				appName,
				region,
				projectRoot,
			})
		}

		logger.success('Generated deploy artifacts and persisted deploy state.')
		logger.warn(
			`Platform provisioning/deployment for "${platform}" is planned next. This run completed local build and artifact generation.`,
		)
	},
})

interface ResolvePlatformOptions {
	promptClient: ReturnType<typeof createPromptClient>
	platformArg: unknown
	storedPlatform: DeployPlatform | undefined
	confirm: boolean
}

async function resolvePlatform(options: ResolvePlatformOptions): Promise<DeployPlatform> {
	if (typeof options.platformArg === 'string') {
		if (!isDeployPlatform(options.platformArg)) {
			throw new Error(
				`Invalid --platform value "${options.platformArg}". Valid options: ${DEPLOY_PLATFORMS.join(', ')}`,
			)
		}
		return options.platformArg
	}

	if (options.storedPlatform) {
		return options.storedPlatform
	}

	if (options.confirm || !isInteractiveTerminal()) {
		return 'fly'
	}

	return await options.promptClient.select('Where do you want to deploy?', [
		{
			label: 'Fly.io (recommended for sync apps)',
			value: 'fly',
		},
		{
			label: 'Railway',
			value: 'railway',
		},
		{
			label: 'Render',
			value: 'render',
		},
		{
			label: 'Docker (self-hosted)',
			value: 'docker',
		},
		{
			label: 'Kora Cloud (coming soon)',
			value: 'kora-cloud',
		},
	])
}

function resolveAppName(
	argValue: unknown,
	storedValue: string | undefined,
	projectRoot: string,
): string {
	if (typeof argValue === 'string' && argValue.length > 0) {
		return sanitizeAppName(argValue)
	}

	if (storedValue && storedValue.length > 0) {
		return storedValue
	}

	return sanitizeAppName(basename(projectRoot))
}

function resolveRegion(argValue: unknown, storedValue: string | null | undefined): string | null {
	if (typeof argValue === 'string' && argValue.length > 0) return argValue
	if (storedValue !== undefined) return storedValue
	return 'iad'
}

function sanitizeAppName(value: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^-|-$/g, '')

	if (normalized.length === 0) {
		return 'kora-app'
	}
	return normalized
}

async function requireProjectRoot(): Promise<string> {
	const projectRoot = await findProjectRoot()
	if (!projectRoot) {
		throw new InvalidProjectError(process.cwd())
	}
	return projectRoot
}

function isInteractiveTerminal(): boolean {
	return process.stdin.isTTY === true && process.stdout.isTTY === true
}
