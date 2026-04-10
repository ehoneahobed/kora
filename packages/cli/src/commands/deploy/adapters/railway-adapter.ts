import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createLogger } from '../../../utils/logger'
import { writeRailwayJsonArtifact } from '../artifacts/railway-json-generator'
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
 * Execution abstraction for Railway CLI shell interactions.
 */
export interface RailwayCommandRunner {
	run(command: string, args: string[], cwd: string): Promise<RailwayCommandResult>
}

export interface RailwayCommandResult {
	exitCode: number
	stdout: string
	stderr: string
}

export interface RailwayAdapterOptions {
	runner?: RailwayCommandRunner
	context?: RailwayAdapterContext
	commandCandidates?: readonly string[]
}

/**
 * Railway deploy adapter implementation for Phase 13.
 */
export class RailwayAdapter implements ContextAwareDeployAdapter {
	public readonly name = 'railway' as const

	private readonly logger = createLogger()
	private readonly runner: RailwayCommandRunner
	private readonly commandCandidates: readonly string[]
	private railwayCommand: string | null = null
	private currentContext: RailwayAdapterContext | null
	private lastDeploymentId: string | null = null

	public constructor(options: RailwayAdapterOptions = {}) {
		this.runner = options.runner ?? new NodeRailwayCommandRunner()
		this.commandCandidates = options.commandCandidates ?? DEFAULT_RAILWAY_COMMAND_CANDIDATES
		this.currentContext = options.context ?? null
	}

	public setContext(context: RailwayAdapterContext): void {
		this.currentContext = context
	}

	public async detect(): Promise<boolean> {
		const command = await this.tryResolveRailwayCommand(process.cwd())
		return command !== null
	}

	public async install(): Promise<void> {
		const available = await this.detect()
		if (!available) {
			throw new Error(
				'Railway CLI is required but not installed. Install with `npm i -g @railway/cli` or see https://docs.railway.com/guides/cli.',
			)
		}
	}

	public async authenticate(): Promise<void> {
		const projectRoot = this.currentContext?.projectRoot ?? process.cwd()
		const whoami = await this.runRailwayCommand(['whoami'], projectRoot, false)
		if (whoami.exitCode === 0) return

		const login = await this.runRailwayCommand(['login'], projectRoot, true)
		if (login.exitCode !== 0) {
			throw new Error(
				`Railway authentication failed: ${normalizeError(login.stderr, login.stdout)}`,
			)
		}
	}

	public async provision(config: ProjectConfig): Promise<ProvisionResult> {
		this.currentContext = {
			projectRoot: config.projectRoot,
			appName: config.appName,
			region: config.region,
		}

		const init = await this.runRailwayCommand(
			['init', '--name', config.appName, '--confirm'],
			config.projectRoot,
			false,
		)
		if (init.exitCode !== 0 && !isAlreadyExistsResponse(init.stderr, init.stdout)) {
			throw new Error(
				`Railway project provisioning failed for "${config.appName}": ${normalizeError(init.stderr, init.stdout)}`,
			)
		}

		const link = await this.runRailwayCommand(
			['link', '--project', config.appName, '--environment', config.environment, '--yes'],
			config.projectRoot,
			false,
		)
		if (link.exitCode !== 0 && !isAlreadyExistsResponse(link.stderr, link.stdout)) {
			throw new Error(`Railway link failed: ${normalizeError(link.stderr, link.stdout)}`)
		}

		const vars: string[] = []
		const setPort = await this.runRailwayCommand(
			['variables', 'set', 'PORT=3000', '--yes'],
			config.projectRoot,
			false,
		)
		if (setPort.exitCode === 0) {
			vars.push('PORT')
		}

		return {
			applicationId: config.appName,
			databaseId: null,
			secretsSet: vars,
		}
	}

	public async build(config: ProjectConfig): Promise<BuildArtifacts> {
		this.currentContext = {
			projectRoot: config.projectRoot,
			appName: config.appName,
			region: config.region,
		}
		const deployDirectory = join(config.projectRoot, '.kora', 'deploy')
		await writeRailwayJsonArtifact(deployDirectory, {
			appName: config.appName,
			environment: config.environment,
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

	public async deploy(artifacts: BuildArtifacts): Promise<DeployResult> {
		const context = this.requireContext()
		const up = await this.runRailwayCommand(['up', '--yes'], artifacts.deployDirectory, true)
		if (up.exitCode !== 0) {
			throw new Error(`Railway deployment failed: ${normalizeError(up.stderr, up.stdout)}`)
		}

		const status = await this.runRailwayCommand(['status', '--json'], context.projectRoot, false)
		const deploymentId = parseRailwayDeploymentId(status.stdout) ?? new Date().toISOString()
		const liveUrl = parseRailwayUrl(status.stdout) ?? `https://${context.appName}.up.railway.app`
		this.lastDeploymentId = deploymentId

		return {
			deploymentId,
			liveUrl,
			syncUrl: toSyncUrl(liveUrl),
		}
	}

	public async rollback(deploymentId: string): Promise<void> {
		const context = this.requireContext()
		const rollback = await this.runRailwayCommand(
			['redeploy', '--deployment', deploymentId, '--yes'],
			context.projectRoot,
			true,
		)
		if (rollback.exitCode !== 0) {
			throw new Error(
				`Railway rollback failed: ${normalizeError(rollback.stderr, rollback.stdout)}`,
			)
		}
	}

	public async *logs(options: LogOptions): AsyncIterable<LogLine> {
		const context = this.requireContext()
		const args = ['logs']
		if (typeof options.tail === 'number' && options.tail > 0) {
			args.push('--lines', String(options.tail))
		}

		const result = await this.runRailwayCommand(args, context.projectRoot, false)
		if (result.exitCode !== 0) {
			throw new Error(`Railway logs failed: ${normalizeError(result.stderr, result.stdout)}`)
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

	public async status(): Promise<DeploymentStatus> {
		const context = this.requireContext()
		const status = await this.runRailwayCommand(['status', '--json'], context.projectRoot, false)
		if (status.exitCode !== 0) {
			return {
				state: 'failed',
				message: normalizeError(status.stderr, status.stdout),
			}
		}

		const liveUrl = parseRailwayUrl(status.stdout)
		return {
			state: 'healthy',
			message: 'Railway deployment is healthy.',
			liveUrl: liveUrl ?? undefined,
		}
	}

	private async runRailwayCommand(
		railwayArgs: string[],
		cwd: string,
		inheritOutput: boolean,
	): Promise<RailwayCommandResult> {
		const command = await this.resolveRailwayCommand(cwd)
		if (inheritOutput) {
			this.logger.step(`railway ${railwayArgs.join(' ')}`)
		}
		return await this.runner.run(command, railwayArgs, cwd)
	}

	private requireContext(): RailwayAdapterContext {
		if (!this.currentContext) {
			throw new Error('Railway adapter context is not initialized. Run provision() first.')
		}
		return this.currentContext
	}

	private async resolveRailwayCommand(cwd: string): Promise<string> {
		if (this.railwayCommand) {
			return this.railwayCommand
		}
		const resolved = await this.tryResolveRailwayCommand(cwd)
		if (!resolved) {
			throw new Error('Could not resolve a usable Railway CLI command (tried railway).')
		}
		this.railwayCommand = resolved
		return resolved
	}

	private async tryResolveRailwayCommand(cwd: string): Promise<string | null> {
		for (const command of this.commandCandidates) {
			const version = await this.runner.run(command, ['--version'], cwd)
			if (version.exitCode === 0) {
				return command
			}
		}
		return null
	}
}

/**
 * Default subprocess-backed runner for Railway commands.
 */
export class NodeRailwayCommandRunner implements RailwayCommandRunner {
	public async run(command: string, args: string[], cwd: string): Promise<RailwayCommandResult> {
		return await new Promise<RailwayCommandResult>((resolve) => {
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

export interface RailwayAdapterContext {
	projectRoot: string
	appName: string
	region: string | null
}

const DEFAULT_RAILWAY_COMMAND_CANDIDATES = ['railway'] as const

function parseRailwayUrl(rawJson: string): string | null {
	const record = parseJsonRecord(rawJson)
	if (!record) return null

	const url = record.url
	if (typeof url === 'string' && url.length > 0) {
		return ensureHttpsUrl(url)
	}

	const service = record.service
	if (typeof service === 'object' && service !== null) {
		const domain = (service as Record<string, unknown>).domain
		if (typeof domain === 'string' && domain.length > 0) {
			return ensureHttpsUrl(domain)
		}
	}

	return null
}

function parseRailwayDeploymentId(rawJson: string): string | null {
	const record = parseJsonRecord(rawJson)
	if (!record) return null

	const deploymentId = record.deploymentId
	if (typeof deploymentId === 'string' && deploymentId.length > 0) {
		return deploymentId
	}

	const deployment = record.deployment
	if (typeof deployment === 'object' && deployment !== null) {
		const id = (deployment as Record<string, unknown>).id
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

function toSyncUrl(liveUrl: string): string | null {
	try {
		const url = new URL(liveUrl)
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
		url.pathname = '/kora-sync'
		return url.toString().replace(/\/$/, '')
	} catch {
		return null
	}
}

function ensureHttpsUrl(value: string): string {
	if (value.startsWith('http://') || value.startsWith('https://')) {
		return value
	}
	return `https://${value}`
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
	return 'unknown railway CLI error'
}

function isAlreadyExistsResponse(stderr: string, stdout: string): boolean {
	const text = `${stderr}\n${stdout}`.toLowerCase()
	return text.includes('already exists')
}
