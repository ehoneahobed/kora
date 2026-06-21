import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createLogger } from '../../../utils/logger'
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
 * Execution abstraction for AWS CLI interactions.
 */
export interface AwsLightsailCommandRunner {
	run(command: string, args: string[], cwd: string): Promise<AwsLightsailCommandResult>
}

export interface AwsLightsailCommandResult {
	exitCode: number
	stdout: string
	stderr: string
}

export interface AwsLightsailAdapterOptions {
	runner?: AwsLightsailCommandRunner
	context?: AwsLightsailAdapterContext
}

export interface AwsLightsailAdapterContext {
	projectRoot: string
	appName: string
	region: string | null
}

/**
 * AWS Lightsail Container Service deploy adapter.
 *
 * Uses the AWS CLI to:
 * 1. Create a Lightsail container service
 * 2. Build and push the Docker image
 * 3. Create a deployment with the container image
 *
 * Requires: `aws` CLI installed and configured with valid credentials,
 * plus the `lightsailctl` plugin for container image pushes.
 *
 * Recommended for simple, cost-effective container deployments.
 */
export class AwsLightsailAdapter implements ContextAwareDeployAdapter {
	public readonly name = 'aws-lightsail' as const

	private readonly logger = createLogger()
	private readonly runner: AwsLightsailCommandRunner
	private currentContext: AwsLightsailAdapterContext | null

	public constructor(options: AwsLightsailAdapterOptions = {}) {
		this.runner = options.runner ?? new NodeAwsLightsailCommandRunner()
		this.currentContext = options.context ?? null
	}

	public setContext(context: AwsLightsailAdapterContext): void {
		this.currentContext = context
	}

	public async detect(): Promise<boolean> {
		const result = await this.runner.run('aws', ['--version'], process.cwd())
		return result.exitCode === 0
	}

	public async install(): Promise<void> {
		const available = await this.detect()
		if (!available) {
			throw new Error(
				'AWS CLI is required but not installed. Install from https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
			)
		}
	}

	public async authenticate(): Promise<void> {
		const cwd = this.currentContext?.projectRoot ?? process.cwd()
		const result = await this.runner.run('aws', ['sts', 'get-caller-identity'], cwd)
		if (result.exitCode !== 0) {
			throw new Error(
				'AWS CLI is not authenticated. Run `aws configure` or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.',
			)
		}
	}

	public async provision(config: ProjectConfig): Promise<ProvisionResult> {
		this.currentContext = {
			projectRoot: config.projectRoot,
			appName: config.appName,
			region: config.region ?? 'us-east-1',
		}

		const region = config.region ?? 'us-east-1'
		const serviceName = sanitizeLightsailName(config.appName)

		// Create Lightsail container service (idempotent — errors if already exists)
		const createService = await this.runner.run(
			'aws',
			[
				'lightsail',
				'create-container-service',
				'--service-name',
				serviceName,
				'--power',
				'nano',
				'--scale',
				'1',
				'--region',
				region,
			],
			config.projectRoot,
		)

		if (createService.exitCode !== 0 && !createService.stderr.includes('already exists')) {
			throw new Error(`Failed to create Lightsail container service: ${createService.stderr}`)
		}

		return {
			applicationId: serviceName,
			databaseId: null,
			secretsSet: ['PORT'],
		}
	}

	public async build(config: ProjectConfig): Promise<BuildArtifacts> {
		this.currentContext = {
			projectRoot: config.projectRoot,
			appName: config.appName,
			region: config.region,
		}

		const deployDirectory = join(config.projectRoot, '.kora', 'deploy')

		await bundleServer({
			projectRoot: config.projectRoot,
			deployDirectory,
		})

		const client =
			config.deployTarget === 'sync-server'
				? null
				: await buildClient({
						projectRoot: config.projectRoot,
						outDir: join(deployDirectory, 'dist'),
						mode: 'production',
					})

		return {
			clientDirectory: client?.outDir ?? null,
			serverBundlePath: join(deployDirectory, 'server-bundled.js'),
			deployDirectory,
		}
	}

	public async deploy(artifacts: BuildArtifacts): Promise<DeployResult> {
		const context = this.requireContext()
		const region = context.region ?? 'us-east-1'
		const serviceName = sanitizeLightsailName(context.appName)
		const imageTag = `${serviceName}:latest`

		// Build Docker image locally
		this.logger.step('Building Docker image...')
		const dockerBuild = await this.runner.run(
			'docker',
			['build', '--platform', 'linux/amd64', '-t', imageTag, '.'],
			artifacts.deployDirectory,
		)

		if (dockerBuild.exitCode !== 0) {
			throw new Error(`Docker build failed: ${dockerBuild.stderr}`)
		}

		// Push image to Lightsail using lightsailctl plugin
		this.logger.step('Pushing image to Lightsail...')
		const pushImage = await this.runner.run(
			'aws',
			[
				'lightsail',
				'push-container-image',
				'--service-name',
				serviceName,
				'--label',
				'latest',
				'--image',
				imageTag,
				'--region',
				region,
			],
			artifacts.deployDirectory,
		)

		if (pushImage.exitCode !== 0) {
			throw new Error(`Lightsail image push failed: ${pushImage.stderr}`)
		}

		// Parse the image reference from the push output
		const lightsailImage = parseLightsailImageRef(pushImage.stdout) ?? `:${serviceName}.latest.1`

		// Create deployment
		this.logger.step('Creating Lightsail deployment...')
		const environment: Record<string, string> = { PORT: '3001' }
		// Pass through deployment-relevant env vars
		for (const key of PASSTHROUGH_ENV_VARS) {
			const value = process.env[key]
			if (value) {
				environment[key] = value
			}
		}
		const containers = JSON.stringify({
			[serviceName]: {
				image: lightsailImage,
				ports: { '3001': 'HTTP' },
				environment,
			},
		})
		const publicEndpoint = JSON.stringify({
			containerName: serviceName,
			containerPort: 3001,
			healthCheck: {
				path: '/health',
				intervalSeconds: 30,
				timeoutSeconds: 5,
				healthyThreshold: 2,
				unhealthyThreshold: 3,
			},
		})

		const createDeploy = await this.runner.run(
			'aws',
			[
				'lightsail',
				'create-container-service-deployment',
				'--service-name',
				serviceName,
				'--containers',
				containers,
				'--public-endpoint',
				publicEndpoint,
				'--region',
				region,
			],
			context.projectRoot,
		)

		if (createDeploy.exitCode !== 0) {
			throw new Error(`Lightsail deployment failed: ${createDeploy.stderr}`)
		}

		// Get the service URL
		const serviceInfo = await this.runner.run(
			'aws',
			['lightsail', 'get-container-services', '--service-name', serviceName, '--region', region],
			context.projectRoot,
		)

		const rawUrl =
			parseLightsailUrl(serviceInfo.stdout) ??
			`https://${serviceName}.${region}.cs.amazonlightsail.com`
		const serviceUrl = rawUrl.replace(/\/+$/, '')
		const deploymentId = new Date().toISOString()

		return {
			deploymentId,
			liveUrl: serviceUrl,
			syncUrl: `${serviceUrl.replace('https://', 'wss://')}/kora-sync`,
		}
	}

	public async rollback(_deploymentId: string): Promise<void> {
		const context = this.requireContext()
		const region = context.region ?? 'us-east-1'
		const serviceName = sanitizeLightsailName(context.appName)

		// Lightsail doesn't have a native rollback — get previous deployment version
		// and redeploy. For now, we list deployments and use the previous container image.
		const deployments = await this.runner.run(
			'aws',
			[
				'lightsail',
				'get-container-service-deployments',
				'--service-name',
				serviceName,
				'--region',
				region,
			],
			context.projectRoot,
		)

		if (deployments.exitCode !== 0) {
			throw new Error(`Lightsail rollback failed: ${deployments.stderr}`)
		}

		// Parse previous deployment and re-create it
		const previousDeployment = parsePreviousDeployment(deployments.stdout, serviceName)
		if (!previousDeployment) {
			throw new Error('No previous deployment found to rollback to.')
		}

		const redeploy = await this.runner.run(
			'aws',
			[
				'lightsail',
				'create-container-service-deployment',
				'--service-name',
				serviceName,
				'--containers',
				JSON.stringify(previousDeployment.containers),
				'--public-endpoint',
				JSON.stringify(previousDeployment.publicEndpoint),
				'--region',
				region,
			],
			context.projectRoot,
		)

		if (redeploy.exitCode !== 0) {
			throw new Error(`Lightsail rollback deployment failed: ${redeploy.stderr}`)
		}
	}

	public async *logs(options: LogOptions): AsyncIterable<LogLine> {
		const context = this.requireContext()
		const region = context.region ?? 'us-east-1'
		const serviceName = sanitizeLightsailName(context.appName)

		const args = [
			'lightsail',
			'get-container-log',
			'--service-name',
			serviceName,
			'--container-name',
			serviceName,
			'--region',
			region,
		]

		if (options.since) {
			args.push('--start-time', options.since)
		}

		const result = await this.runner.run('aws', args, context.projectRoot)
		if (result.exitCode !== 0) {
			return
		}

		try {
			const parsed = JSON.parse(result.stdout) as {
				logEvents?: Array<{ createdAt: string; message: string }>
			}
			const events = parsed.logEvents ?? []
			const limited = options.tail ? events.slice(-options.tail) : events
			for (const event of limited) {
				yield {
					timestamp: event.createdAt,
					level: inferLogLevel(event.message),
					message: event.message,
				}
			}
		} catch {
			for (const line of result.stdout.split('\n').filter(Boolean)) {
				yield { timestamp: new Date().toISOString(), level: 'info', message: line }
			}
		}
	}

	public async status(): Promise<DeploymentStatus> {
		const context = this.requireContext()
		const region = context.region ?? 'us-east-1'
		const serviceName = sanitizeLightsailName(context.appName)

		const result = await this.runner.run(
			'aws',
			['lightsail', 'get-container-services', '--service-name', serviceName, '--region', region],
			context.projectRoot,
		)

		if (result.exitCode !== 0) {
			return { state: 'failed', message: result.stderr }
		}

		try {
			const parsed = JSON.parse(result.stdout) as {
				containerServices?: Array<{
					state: string
					url: string
					currentDeployment?: { state: string }
				}>
			}
			const service = parsed.containerServices?.[0]
			if (!service) {
				return { state: 'unknown', message: 'Container service not found' }
			}

			const deployState = service.currentDeployment?.state ?? 'UNKNOWN'
			if (service.state === 'RUNNING' && deployState === 'ACTIVE') {
				return {
					state: 'healthy',
					message: 'Lightsail container service is running',
					liveUrl: service.url,
				}
			}

			if (service.state === 'DEPLOYING' || deployState === 'ACTIVATING') {
				return {
					state: 'pending',
					message: `Service: ${service.state}, Deployment: ${deployState}`,
				}
			}

			return {
				state: service.state === 'DISABLED' ? 'failed' : 'unknown',
				message: `Service: ${service.state}, Deployment: ${deployState}`,
			}
		} catch {
			return { state: 'unknown', message: 'Could not parse service status' }
		}
	}

	private requireContext(): AwsLightsailAdapterContext {
		if (!this.currentContext) {
			throw new Error('AWS Lightsail adapter context is not initialized. Run provision() first.')
		}
		return this.currentContext
	}
}

/**
 * Default subprocess-backed runner for AWS CLI commands.
 */
export class NodeAwsLightsailCommandRunner implements AwsLightsailCommandRunner {
	public async run(
		command: string,
		args: string[],
		cwd: string,
	): Promise<AwsLightsailCommandResult> {
		return new Promise<AwsLightsailCommandResult>((resolve) => {
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
				resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}` })
			})
			child.on('exit', (code) => {
				resolve({ exitCode: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() })
			})
		})
	}
}

/**
 * Environment variables automatically forwarded from the host to the Lightsail container.
 */
const PASSTHROUGH_ENV_VARS = ['DATABASE_URL', 'AUTH_SECRET', 'PUBLIC_URL', 'NODE_ENV'] as const

/**
 * Lightsail service names must be 2-255 chars, lowercase alphanumeric and hyphens only.
 */
function sanitizeLightsailName(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, '-')
			.replace(/-{2,}/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 255) || 'kora-app'
	)
}

function parseLightsailImageRef(output: string): string | null {
	// The push output contains a line like: "Refer to this image as `:service.label.N` ..."
	const match = output.match(/Refer to this image as\s+"?(:[^"\s]+)"?/i)
	if (match?.[1]) {
		return match[1]
	}
	// Fallback: look for the image reference pattern
	const refMatch = output.match(/(:\S+\.\S+\.\d+)/)
	return refMatch?.[1] ?? null
}

function parseLightsailUrl(rawJson: string): string | null {
	try {
		const parsed = JSON.parse(rawJson) as {
			containerServices?: Array<{ url?: string }>
		}
		const url = parsed.containerServices?.[0]?.url
		if (typeof url === 'string' && url.length > 0) {
			return url.startsWith('https://') ? url : `https://${url}`
		}
		return null
	} catch {
		return null
	}
}

interface DeploymentConfig {
	containers: Record<string, unknown>
	publicEndpoint: Record<string, unknown>
}

function parsePreviousDeployment(rawJson: string, serviceName: string): DeploymentConfig | null {
	try {
		const parsed = JSON.parse(rawJson) as {
			deployments?: Array<{
				state: string
				containers: Record<string, unknown>
				publicEndpoint: Record<string, unknown>
			}>
		}
		const deployments = parsed.deployments ?? []
		// Find the second deployment (index 1) — first is current, second is previous
		const previous = deployments.length > 1 ? deployments[1] : null
		if (!previous) return null

		return {
			containers: previous.containers,
			publicEndpoint: previous.publicEndpoint,
		}
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
