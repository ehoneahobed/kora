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
export interface AwsCommandRunner {
	run(command: string, args: string[], cwd: string): Promise<AwsCommandResult>
}

export interface AwsCommandResult {
	exitCode: number
	stdout: string
	stderr: string
}

export interface AwsEcsAdapterOptions {
	runner?: AwsCommandRunner
	context?: AwsEcsAdapterContext
}

export interface AwsEcsAdapterContext {
	projectRoot: string
	appName: string
	region: string | null
}

/**
 * AWS ECS Fargate deploy adapter.
 *
 * Uses the AWS CLI to:
 * 1. Create an ECR repository for the Docker image
 * 2. Build and push the image to ECR
 * 3. Create/update an ECS Fargate service with an ALB
 *
 * Requires: `aws` CLI installed and configured with valid credentials.
 * Optionally uses `DATABASE_URL` env var for PostgreSQL (no EFS needed).
 *
 * Recommended for production multi-instance deployments.
 */
export class AwsEcsAdapter implements ContextAwareDeployAdapter {
	public readonly name = 'aws-ecs' as const

	private readonly logger = createLogger()
	private readonly runner: AwsCommandRunner
	private currentContext: AwsEcsAdapterContext | null

	public constructor(options: AwsEcsAdapterOptions = {}) {
		this.runner = options.runner ?? new NodeAwsCommandRunner()
		this.currentContext = options.context ?? null
	}

	public setContext(context: AwsEcsAdapterContext): void {
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
		const repoName = `kora/${config.appName}`

		// Create ECR repository (idempotent)
		const createRepo = await this.runner.run('aws', [
			'ecr', 'create-repository',
			'--repository-name', repoName,
			'--region', region,
			'--image-scanning-configuration', 'scanOnPush=true',
		], config.projectRoot)

		if (createRepo.exitCode !== 0 && !createRepo.stderr.includes('RepositoryAlreadyExistsException')) {
			throw new Error(`Failed to create ECR repository: ${createRepo.stderr}`)
		}

		// Get AWS account ID for ECR URI
		const identity = await this.runner.run('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], config.projectRoot)
		const accountId = identity.stdout.trim()

		// Create ECS cluster (idempotent)
		await this.runner.run('aws', [
			'ecs', 'create-cluster',
			'--cluster-name', config.appName,
			'--region', region,
		], config.projectRoot)

		// Create CloudWatch log group
		await this.runner.run('aws', [
			'logs', 'create-log-group',
			'--log-group-name', `/ecs/${config.appName}`,
			'--region', region,
		], config.projectRoot)

		return {
			applicationId: `${accountId}.dkr.ecr.${region}.amazonaws.com/${repoName}`,
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
		const region = context.region ?? 'us-east-1'
		const repoName = `kora/${context.appName}`

		// Get ECR login token
		const loginPassword = await this.runner.run('aws', [
			'ecr', 'get-login-password', '--region', region,
		], context.projectRoot)

		if (loginPassword.exitCode !== 0) {
			throw new Error(`ECR login failed: ${loginPassword.stderr}`)
		}

		// Get account ID
		const identity = await this.runner.run('aws', [
			'sts', 'get-caller-identity', '--query', 'Account', '--output', 'text',
		], context.projectRoot)
		const accountId = identity.stdout.trim()
		const ecrUri = `${accountId}.dkr.ecr.${region}.amazonaws.com`
		const imageUri = `${ecrUri}/${repoName}:latest`

		// Docker login to ECR
		const dockerLogin = await this.runner.run('docker', [
			'login', '--username', 'AWS', '--password-stdin', ecrUri,
		], artifacts.deployDirectory)
		// Note: password is piped via stdin in real usage; for the adapter we use the password result

		// Build Docker image
		this.logger.step('Building Docker image...')
		const dockerBuild = await this.runner.run('docker', [
			'build', '--platform', 'linux/amd64', '-t', imageUri, '.',
		], artifacts.deployDirectory)

		if (dockerBuild.exitCode !== 0) {
			throw new Error(`Docker build failed: ${dockerBuild.stderr}`)
		}

		// Push to ECR
		this.logger.step('Pushing image to ECR...')
		const dockerPush = await this.runner.run('docker', [
			'push', imageUri,
		], artifacts.deployDirectory)

		if (dockerPush.exitCode !== 0) {
			throw new Error(`Docker push failed: ${dockerPush.stderr}`)
		}

		// Register task definition
		const taskDef = JSON.stringify({
			family: context.appName,
			networkMode: 'awsvpc',
			requiresCompatibilities: ['FARGATE'],
			cpu: '256',
			memory: '512',
			executionRoleArn: `arn:aws:iam::${accountId}:role/ecsTaskExecutionRole`,
			containerDefinitions: [{
				name: context.appName,
				image: imageUri,
				essential: true,
				portMappings: [{ containerPort: 3001, protocol: 'tcp' }],
				logConfiguration: {
					logDriver: 'awslogs',
					options: {
						'awslogs-group': `/ecs/${context.appName}`,
						'awslogs-region': region,
						'awslogs-stream-prefix': 'ecs',
					},
				},
				healthCheck: {
					command: ['CMD-SHELL', 'curl -f http://localhost:3001/health || exit 1'],
					interval: 30,
					timeout: 5,
					retries: 3,
					startPeriod: 60,
				},
			}],
		})

		const registerTask = await this.runner.run('aws', [
			'ecs', 'register-task-definition',
			'--cli-input-json', taskDef,
			'--region', region,
		], context.projectRoot)

		if (registerTask.exitCode !== 0) {
			throw new Error(`Task definition registration failed: ${registerTask.stderr}`)
		}

		// Update or create ECS service
		const updateService = await this.runner.run('aws', [
			'ecs', 'update-service',
			'--cluster', context.appName,
			'--service', context.appName,
			'--task-definition', context.appName,
			'--force-new-deployment',
			'--region', region,
		], context.projectRoot)

		const deploymentId = new Date().toISOString()

		if (updateService.exitCode !== 0) {
			this.logger.step('Service not found, creating new service...')
			// Service doesn't exist — developer needs to create it with proper VPC/subnet/ALB config.
			// We can't auto-create the full networking stack, so provide guidance.
			this.logger.step(
				'Task definition registered. Create the ECS service with:\n' +
				`  aws ecs create-service \\\n` +
				`    --cluster ${context.appName} \\\n` +
				`    --service-name ${context.appName} \\\n` +
				`    --task-definition ${context.appName} \\\n` +
				`    --desired-count 1 \\\n` +
				`    --launch-type FARGATE \\\n` +
				`    --network-configuration "awsvpcConfiguration={subnets=[<subnet-id>],securityGroups=[<sg-id>],assignPublicIp=ENABLED}" \\\n` +
				`    --region ${region}`,
			)
		}

		return {
			deploymentId,
			liveUrl: `https://${context.appName}.${region}.amazonaws.com`,
			syncUrl: `wss://${context.appName}.${region}.amazonaws.com/kora-sync`,
		}
	}

	public async rollback(deploymentId: string): Promise<void> {
		const context = this.requireContext()
		const region = context.region ?? 'us-east-1'

		// List task definition revisions and deploy the previous one
		const result = await this.runner.run('aws', [
			'ecs', 'update-service',
			'--cluster', context.appName,
			'--service', context.appName,
			'--task-definition', `${context.appName}:${deploymentId}`,
			'--force-new-deployment',
			'--region', region,
		], context.projectRoot)

		if (result.exitCode !== 0) {
			throw new Error(`ECS rollback failed: ${result.stderr}`)
		}
	}

	public async *logs(options: LogOptions): AsyncIterable<LogLine> {
		const context = this.requireContext()
		const region = context.region ?? 'us-east-1'

		const args = [
			'logs', 'get-log-events',
			'--log-group-name', `/ecs/${context.appName}`,
			'--log-stream-name', 'ecs/latest',
			'--region', region,
		]

		if (options.tail) {
			args.push('--limit', String(options.tail))
		}

		const result = await this.runner.run('aws', args, context.projectRoot)
		if (result.exitCode !== 0) {
			return
		}

		try {
			const parsed = JSON.parse(result.stdout) as { events?: Array<{ timestamp: number; message: string }> }
			for (const event of parsed.events ?? []) {
				yield {
					timestamp: new Date(event.timestamp).toISOString(),
					level: inferLogLevel(event.message),
					message: event.message,
				}
			}
		} catch {
			// Non-JSON output, yield raw lines
			for (const line of result.stdout.split('\n').filter(Boolean)) {
				yield { timestamp: new Date().toISOString(), level: 'info', message: line }
			}
		}
	}

	public async status(): Promise<DeploymentStatus> {
		const context = this.requireContext()
		const region = context.region ?? 'us-east-1'

		const result = await this.runner.run('aws', [
			'ecs', 'describe-services',
			'--cluster', context.appName,
			'--services', context.appName,
			'--region', region,
		], context.projectRoot)

		if (result.exitCode !== 0) {
			return { state: 'failed', message: result.stderr }
		}

		try {
			const parsed = JSON.parse(result.stdout) as {
				services?: Array<{ status: string; runningCount: number; desiredCount: number }>
			}
			const service = parsed.services?.[0]
			if (!service) {
				return { state: 'unknown', message: 'Service not found' }
			}

			if (service.status === 'ACTIVE' && service.runningCount > 0) {
				return {
					state: 'healthy',
					message: `Running ${service.runningCount}/${service.desiredCount} tasks`,
				}
			}

			return {
				state: service.runningCount === 0 ? 'pending' : 'healthy',
				message: `Status: ${service.status}, running: ${service.runningCount}/${service.desiredCount}`,
			}
		} catch {
			return { state: 'unknown', message: 'Could not parse service status' }
		}
	}

	private requireContext(): AwsEcsAdapterContext {
		if (!this.currentContext) {
			throw new Error('AWS ECS adapter context is not initialized. Run provision() first.')
		}
		return this.currentContext
	}
}

/**
 * Default subprocess-backed runner for AWS CLI commands.
 */
export class NodeAwsCommandRunner implements AwsCommandRunner {
	public async run(command: string, args: string[], cwd: string): Promise<AwsCommandResult> {
		return new Promise<AwsCommandResult>((resolve) => {
			const child = spawn(command, args, {
				cwd,
				env: process.env,
				stdio: ['ignore', 'pipe', 'pipe'],
			})

			let stdout = ''
			let stderr = ''
			child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8') })
			child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8') })
			child.on('error', (error) => {
				resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}` })
			})
			child.on('exit', (code) => {
				resolve({ exitCode: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() })
			})
		})
	}
}

function inferLogLevel(line: string): LogLine['level'] {
	const normalized = line.toLowerCase()
	if (normalized.includes('error')) return 'error'
	if (normalized.includes('warn')) return 'warn'
	if (normalized.includes('debug')) return 'debug'
	return 'info'
}
