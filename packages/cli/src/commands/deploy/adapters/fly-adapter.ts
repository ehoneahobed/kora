import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createLogger } from '../../../utils/logger'
import { writeFlyTomlArtifact } from '../artifacts/fly-toml-generator'
import { buildClient } from '../builder/client-builder'
import { bundleServer } from '../builder/server-bundler'
import type {
	BuildArtifacts,
	ContextAwareDeployAdapter,
	DeployResult,
	DeploymentStatus,
	LogLine,
	LogOptions,
	ProjectConfig,
	ProvisionResult,
} from './adapter'

/**
 * Execution abstraction for Fly CLI shell interactions.
 * This keeps FlyAdapter deterministic and fully mockable in tests.
 */
export interface FlyCommandRunner {
	run(command: string, args: string[], cwd: string): Promise<FlyCommandResult>
}

export interface FlyCommandResult {
	exitCode: number
	stdout: string
	stderr: string
}

export interface FlyAdapterOptions {
	runner?: FlyCommandRunner
	context?: FlyAdapterContext
	commandCandidates?: readonly string[]
}

/**
 * Fly.io deploy adapter implementation for Phase 13.
 */
export class FlyAdapter implements ContextAwareDeployAdapter {
	public readonly name = 'fly' as const

	private readonly logger = createLogger()
	private readonly runner: FlyCommandRunner
	private readonly commandCandidates: readonly string[]
	private flyCommand: string | null = null
	private currentContext: FlyAdapterContext | null
	private lastDeploymentId: string | null = null

	public constructor(options: FlyAdapterOptions = {}) {
		this.runner = options.runner ?? new NodeFlyCommandRunner()
		this.commandCandidates = options.commandCandidates ?? DEFAULT_FLY_COMMAND_CANDIDATES
		this.currentContext = options.context ?? null
	}

	/**
	 * Seeds runtime context for non-provisioning commands.
	 */
	public setContext(context: FlyAdapterContext): void {
		this.currentContext = context
	}

	/**
	 * Checks whether a Fly CLI executable can be resolved.
	 */
	public async detect(): Promise<boolean> {
		const command = await this.tryResolveFlyCommand(process.cwd())
		return command !== null
	}

	/**
	 * Ensures Fly CLI is available before deployment.
	 */
	public async install(): Promise<void> {
		const available = await this.detect()
		if (!available) {
			throw new Error(
				'Fly CLI is required but not installed. Install from https://fly.io/docs/hands-on/install-flyctl/.',
			)
		}
	}

	/**
	 * Performs Fly authentication check/login.
	 */
	public async authenticate(): Promise<void> {
		const projectRoot = this.currentContext?.projectRoot ?? process.cwd()
		const status = await this.runFlyCommand(['auth', 'whoami', '--json'], projectRoot, false)
		if (status.exitCode === 0) return

		const login = await this.runFlyCommand(['auth', 'login'], projectRoot, true)
		if (login.exitCode !== 0) {
			throw new Error(`Fly authentication failed: ${normalizeError(login.stderr, login.stdout)}`)
		}
	}

	/**
	 * Provisions app and optionally region-bound resources in Fly.
	 */
	public async provision(config: ProjectConfig): Promise<ProvisionResult> {
		this.currentContext = {
			projectRoot: config.projectRoot,
			appName: config.appName,
			region: config.region ?? 'iad',
		}

		const appCreateArgs = ['apps', 'create', config.appName]
		if (this.currentContext.region) {
			appCreateArgs.push('--region', this.currentContext.region)
		}
		appCreateArgs.push('--machines')

		const createApp = await this.runFlyCommand(appCreateArgs, config.projectRoot, false)
		if (createApp.exitCode !== 0 && !isAlreadyExistsResponse(createApp.stderr, createApp.stdout)) {
			throw new Error(
				`Fly app provisioning failed for "${config.appName}": ${normalizeError(createApp.stderr, createApp.stdout)}`,
			)
		}

		const secrets: string[] = []
		const portSecret = await this.runFlyCommand(
			['secrets', 'set', 'PORT=3000', '--app', config.appName],
			config.projectRoot,
			false,
		)
		if (portSecret.exitCode === 0) {
			secrets.push('PORT')
		}

		return {
			applicationId: config.appName,
			databaseId: null,
			secretsSet: secrets,
		}
	}

	/**
	 * Builds local artifacts consumed by Fly deploy.
	 */
	public async build(config: ProjectConfig): Promise<BuildArtifacts> {
		this.currentContext = {
			projectRoot: config.projectRoot,
			appName: config.appName,
			region: config.region,
		}
		const deployDirectory = join(config.projectRoot, '.kora', 'deploy')
		await writeFlyTomlArtifact(deployDirectory, {
			appName: config.appName,
			region: config.region ?? 'iad',
		})

		await bundleServer({
			projectRoot: config.projectRoot,
			deployDirectory,
		})
		const client = await buildClient({
			projectRoot: config.projectRoot,
			outDir: join(deployDirectory, 'dist'),
			mode: 'production',
		})

		return {
			clientDirectory: client.outDir,
			serverBundlePath: join(deployDirectory, 'server-bundled.js'),
			deployDirectory,
		}
	}

	/**
	 * Deploys generated artifacts to Fly and returns live endpoints.
	 */
	public async deploy(artifacts: BuildArtifacts): Promise<DeployResult> {
		const context = this.requireContext()
		const deploy = await this.runFlyCommand(
			['deploy', '--config', 'fly.toml', '--app', context.appName],
			artifacts.deployDirectory,
			true,
		)
		if (deploy.exitCode !== 0) {
			throw new Error(`Fly deployment failed: ${normalizeError(deploy.stderr, deploy.stdout)}`)
		}

		const info = await this.runFlyCommand(
			['status', '--app', context.appName, '--json'],
			context.projectRoot,
			false,
		)
		const hostname = parseFlyHostname(info.stdout) ?? `${context.appName}.fly.dev`
		const deploymentId = parseFlyDeploymentId(info.stdout) ?? new Date().toISOString()
		this.lastDeploymentId = deploymentId

		return {
			deploymentId,
			liveUrl: `https://${hostname}`,
			syncUrl: `wss://${hostname}/kora-sync`,
		}
	}

	/**
	 * Rolls back to a deployment version.
	 */
	public async rollback(deploymentId: string): Promise<void> {
		const context = this.requireContext()
		const rollback = await this.runFlyCommand(
			['releases', 'revert', deploymentId, '--app', context.appName],
			context.projectRoot,
			true,
		)
		if (rollback.exitCode !== 0) {
			throw new Error(`Fly rollback failed: ${normalizeError(rollback.stderr, rollback.stdout)}`)
		}
	}

	/**
	 * Returns deployment logs as an async iterable.
	 */
	public async *logs(options: LogOptions): AsyncIterable<LogLine> {
		const context = this.requireContext()
		const args = ['logs', '--app', context.appName]
		if (typeof options.since === 'string' && options.since.length > 0) {
			args.push('--since', options.since)
		}
		if (typeof options.tail === 'number' && options.tail > 0) {
			args.push('--max-lines', String(options.tail))
		}
		const result = await this.runFlyCommand(args, context.projectRoot, false)
		if (result.exitCode !== 0) {
			throw new Error(`Fly logs failed: ${normalizeError(result.stderr, result.stdout)}`)
		}

		const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0)
		for (const line of lines) {
			yield {
				timestamp: new Date().toISOString(),
				level: inferLogLevel(line),
				message: line,
			}
		}
	}

	/**
	 * Reads current deployment status from Fly.
	 */
	public async status(): Promise<DeploymentStatus> {
		const context = this.requireContext()
		const status = await this.runFlyCommand(
			['status', '--app', context.appName, '--json'],
			context.projectRoot,
			false,
		)
		if (status.exitCode !== 0) {
			return {
				state: 'failed',
				message: normalizeError(status.stderr, status.stdout),
			}
		}

		const hostname = parseFlyHostname(status.stdout)
		return {
			state: 'healthy',
			message: 'Fly deployment is healthy.',
			liveUrl: hostname ? `https://${hostname}` : undefined,
		}
	}

	private async runFlyCommand(
		flyArgs: string[],
		cwd: string,
		inheritOutput: boolean,
	): Promise<FlyCommandResult> {
		const flyBinary = await this.resolveFlyCommand(cwd)

		if (inheritOutput) {
			this.logger.step(`fly ${flyArgs.join(' ')}`)
		}
		return await this.runner.run(flyBinary, flyArgs, cwd)
	}

	private requireContext(): FlyAdapterContext {
		if (!this.currentContext) {
			throw new Error('Fly adapter context is not initialized. Run provision() first.')
		}
		return this.currentContext
	}

	private async resolveFlyCommand(cwd: string): Promise<string> {
		if (this.flyCommand) {
			return this.flyCommand
		}

		const resolved = await this.tryResolveFlyCommand(cwd)
		if (!resolved) {
			throw new Error('Could not resolve a usable Fly CLI command (tried flyctl, fly).')
		}
		this.flyCommand = resolved
		return resolved
	}

	private async tryResolveFlyCommand(cwd: string): Promise<string | null> {
		for (const command of this.commandCandidates) {
			const versionCheck = await this.runner.run(command, ['version'], cwd)
			if (versionCheck.exitCode === 0) {
				return command
			}
		}

		return null
	}
}

/**
 * Default subprocess-backed runner for Fly commands.
 */
export class NodeFlyCommandRunner implements FlyCommandRunner {
	public async run(command: string, args: string[], cwd: string): Promise<FlyCommandResult> {
		return await new Promise<FlyCommandResult>((resolve) => {
			const child = spawn(command, args, {
				cwd,
				env: process.env,
				stdio: ['ignore', 'pipe', 'pipe'],
			})

			let stdout = ''
			let stderr = ''
			child.stdout?.on('data', (chunk: Buffer) => {
				stdout += chunk.toString('utf-8')
			})
			child.stderr?.on('data', (chunk: Buffer) => {
				stderr += chunk.toString('utf-8')
			})
			child.on('error', (error) => {
				resolve({
					exitCode: 1,
					stdout,
					stderr: `${stderr}\n${error.message}`,
				})
			})
			child.on('exit', (code) => {
				resolve({
					exitCode: code ?? 1,
					stdout: stdout.trim(),
					stderr: stderr.trim(),
				})
			})
		})
	}
}

export interface FlyAdapterContext {
	projectRoot: string
	appName: string
	region: string | null
}

const DEFAULT_FLY_COMMAND_CANDIDATES = ['flyctl', 'fly'] as const

function parseFlyHostname(rawJson: string): string | null {
	const parsed = parseJsonRecord(rawJson)
	if (!parsed) return null

	const hostname = parsed.Hostname
	if (typeof hostname === 'string' && hostname.length > 0) {
		return hostname
	}

	const hostnames = parsed.Hostnames
	if (Array.isArray(hostnames)) {
		const first = hostnames.find((item) => typeof item === 'string')
		if (typeof first === 'string' && first.length > 0) {
			return first
		}
	}

	return null
}

function parseFlyDeploymentId(rawJson: string): string | null {
	const parsed = parseJsonRecord(rawJson)
	if (!parsed) return null

	const deploymentId = parsed.DeploymentID
	if (typeof deploymentId === 'string' && deploymentId.length > 0) {
		return deploymentId
	}

	const latestDeployment = parsed.LatestDeployment
	if (typeof latestDeployment === 'object' && latestDeployment !== null) {
		const id = (latestDeployment as Record<string, unknown>).ID
		if (typeof id === 'string' && id.length > 0) {
			return id
		}
	}

	return null
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(value) as unknown
		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>
		}
		return null
	} catch {
		return null
	}
}

function inferLogLevel(line: string): LogLine['level'] {
	const normalized = line.toLowerCase()
	if (normalized.includes('error')) return 'error'
	if (normalized.includes('warn')) return 'warn'
	if (normalized.includes('debug')) return 'debug'
	return 'info'
}

function normalizeError(stderr: string, stdout: string): string {
	if (stderr.length > 0) return stderr
	if (stdout.length > 0) return stdout
	return 'unknown fly CLI error'
}

function isAlreadyExistsResponse(stderr: string, stdout: string): boolean {
	const text = `${stderr}\n${stdout}`.toLowerCase()
	return text.includes('already exists')
}
