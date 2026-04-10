import { basename, join } from 'node:path'
import { defineCommand } from 'citty'
import { InvalidProjectError } from '../../errors'
import { createPromptClient } from '../../prompts/prompt-client'
import { findProjectRoot } from '../../utils/fs-helpers'
import { createLogger } from '../../utils/logger'
import {
	type ContextAwareDeployAdapter,
	DEPLOY_PLATFORMS,
	type DeployAdapter,
	type DeployPlatform,
	type ProjectConfig,
	isDeployPlatform,
} from './adapters/adapter'
import { createDeployAdapter } from './adapters/factory'
import {
	writeDockerIgnoreArtifact,
	writeDockerfileArtifact,
} from './artifacts/dockerfile-generator'
import {
	readDeployState,
	resetDeployState,
	resolveDeployDirectory,
	updateDeployState,
	writeDeployState,
} from './state/deploy-state'

/**
 * The `deploy` command for Phase 13.
 *
 * This command orchestrates:
 * - deploy state resolution and persistence
 * - artifact generation
 * - adapter-driven provision/build/deploy flows
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
				description: 'Show current deployment status',
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

				const adapter = createDeployAdapter(state.platform)
				configureAdapterContext(adapter, {
					projectRoot,
					appName: state.appName,
					region: state.region,
				})
				const adapterStatus = await adapter.status()
				logger.step(`Status: ${adapterStatus.state}`)
				logger.step(`Message: ${adapterStatus.message}`)
				logger.step(`Live URL: ${adapterStatus.liveUrl ?? state.liveUrl ?? 'n/a'}`)
				logger.step(`Sync URL: ${state.syncUrl ?? 'n/a'}`)
			},
		}),
		rollback: defineCommand({
			meta: {
				name: 'rollback',
				description: 'Rollback the current deployment',
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

				const adapter = createDeployAdapter(state.platform)
				configureAdapterContext(adapter, {
					projectRoot,
					appName: state.appName,
					region: state.region,
				})
				const deploymentId =
					typeof args.id === 'string' && args.id.length > 0
						? args.id
						: (state.lastDeploymentId ?? 'latest')
				await adapter.rollback(deploymentId)
				logger.success(`Rolled back ${state.platform} deployment to ${deploymentId}.`)
			},
		}),
		logs: defineCommand({
			meta: {
				name: 'logs',
				description: 'Read deployment logs',
			},
			async run() {
				const logger = createLogger()
				const projectRoot = await requireProjectRoot()
				const state = await readDeployState(projectRoot)
				if (!state) {
					logger.warn('No deployment state found. Run `kora deploy` first.')
					return
				}

				const adapter = createDeployAdapter(state.platform)
				configureAdapterContext(adapter, {
					projectRoot,
					appName: state.appName,
					region: state.region,
				})
				const logLines = adapter.logs({ tail: 200 })
				let hasLines = false
				for await (const line of logLines) {
					hasLines = true
					logger.step(`[${line.level}] ${line.message}`)
				}
				if (!hasLines) {
					logger.warn(`No logs returned from ${state.platform}.`)
				}
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
		const confirmMode = args.confirm === true
		const platform = await resolvePlatform({
			promptClient: prompts,
			platformArg: args.platform,
			storedPlatform: existingState?.platform,
			confirm: confirmMode,
		})
		const appName = resolveAppName(args.app, existingState?.appName, projectRoot, confirmMode)
		const region = resolveRegion(args.region, existingState?.region, confirmMode)
		const deployDirectory = resolveDeployDirectory(projectRoot)
		const environment = args.prod === true ? 'production' : 'preview'
		const config: ProjectConfig = {
			projectRoot,
			appName,
			region,
			environment,
			confirm: confirmMode,
		}
		const adapter = createDeployAdapter(platform)
		configureAdapterContext(adapter, {
			projectRoot,
			appName,
			region,
		})

		logger.banner()
		logger.info(
			`Deploying to ${platform} (${appName}${region ? `, ${region}` : ''}, ${environment})`,
		)
		if (confirmMode) {
			logger.step('Running in --confirm mode (non-interactive, fail-fast).')
		}

		await writeDockerfileArtifact(deployDirectory)
		await writeDockerIgnoreArtifact(deployDirectory)
		const detected = await adapter.detect()
		if (!detected) {
			await adapter.install()
		}
		await adapter.authenticate()
		const provisionResult = await adapter.provision(config)
		const artifacts = await adapter.build(config)
		const deployResult = await adapter.deploy(artifacts)

		if (existingState) {
			await updateDeployState(projectRoot, {
				platform,
				appName,
				region,
				projectRoot,
				liveUrl: deployResult.liveUrl,
				syncUrl: deployResult.syncUrl,
				databaseId: provisionResult.databaseId,
				lastDeploymentId: deployResult.deploymentId,
			})
		} else {
			await writeDeployState(projectRoot, {
				platform,
				appName,
				region,
				projectRoot,
				liveUrl: deployResult.liveUrl,
				syncUrl: deployResult.syncUrl,
				databaseId: provisionResult.databaseId,
				lastDeploymentId: deployResult.deploymentId,
			})
		}

		logger.success(`Deployment completed: ${deployResult.liveUrl}`)
		if (deployResult.syncUrl) {
			logger.step(`Sync endpoint: ${deployResult.syncUrl}`)
		}
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
		throw new Error(
			'Missing deploy platform in --confirm mode. Provide --platform or run an interactive deploy first.',
		)
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
	confirm: boolean,
): string {
	if (typeof argValue === 'string' && argValue.length > 0) {
		return sanitizeAppName(argValue)
	}

	if (storedValue && storedValue.length > 0) {
		return storedValue
	}

	if (confirm) {
		throw new Error(
			'Missing app name in --confirm mode. Provide --app or run an interactive deploy first.',
		)
	}

	return sanitizeAppName(basename(projectRoot))
}

function resolveRegion(
	argValue: unknown,
	storedValue: string | null | undefined,
	confirm: boolean,
): string | null {
	if (typeof argValue === 'string' && argValue.length > 0) return argValue
	if (storedValue !== undefined) return storedValue
	if (confirm) {
		throw new Error(
			'Missing region in --confirm mode. Provide --region or run an interactive deploy first.',
		)
	}
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

function configureAdapterContext(
	adapter: DeployAdapter,
	context: { projectRoot: string; appName: string; region: string | null },
): void {
	if (hasContextSetter(adapter)) {
		adapter.setContext(context)
	}
}

function hasContextSetter(adapter: DeployAdapter): adapter is ContextAwareDeployAdapter {
	return typeof (adapter as ContextAwareDeployAdapter).setContext === 'function'
}
