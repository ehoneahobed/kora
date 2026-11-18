export const DEPLOY_PLATFORMS = [
	'fly',
	'railway',
	'aws-ecs',
	'aws-lightsail',
	'render',
	'docker',
	'kora-cloud',
] as const

export type DeployPlatform = (typeof DEPLOY_PLATFORMS)[number]

/**
 * Platforms `kora deploy` can actually deploy to today (DX-8). The others are listed as
 * "coming soon" and refused before anything is written.
 */
export const IMPLEMENTED_DEPLOY_PLATFORMS = [
	'kora-cloud',
	'fly',
	'railway',
	'aws-ecs',
	'aws-lightsail',
] as const

/**
 * Whether `kora deploy` has a working adapter for the platform.
 */
export function isImplementedDeployPlatform(
	platform: DeployPlatform,
): platform is (typeof IMPLEMENTED_DEPLOY_PLATFORMS)[number] {
	return (IMPLEMENTED_DEPLOY_PLATFORMS as readonly string[]).includes(platform)
}

export interface ProjectConfig {
	projectRoot: string
	appName: string
	region: string | null
	environment: 'preview' | 'production'
	confirm: boolean
	deployTarget?: 'full-stack' | 'sync-server'
}

export interface ProvisionResult {
	applicationId: string
	databaseId: string | null
	secretsSet: string[]
}

export interface BuildArtifacts {
	clientDirectory: string | null
	serverBundlePath: string | null
	deployDirectory: string
}

export interface DeployResult {
	deploymentId: string
	/** Where the app answers, when the platform says so; null when it is not known (or not live). */
	liveUrl: string | null
	syncUrl: string | null
	/**
	 * Set when the deploy stopped short of a running app and the developer must finish it (for
	 * example the ECS service is not created yet): what to do next. The deploy is not reported
	 * as completed.
	 */
	pendingSetup?: string
}

export interface LogOptions {
	since?: string
	tail?: number
}

export interface LogLine {
	timestamp: string
	level: 'debug' | 'info' | 'warn' | 'error'
	message: string
}

export interface DeploymentStatus {
	state: 'pending' | 'healthy' | 'failed' | 'unknown'
	message: string
	liveUrl?: string
}

/**
 * Contract implemented by each deployment platform integration.
 */
export interface DeployAdapter {
	name: DeployPlatform
	detect(): Promise<boolean>
	install(): Promise<void>
	authenticate(): Promise<void>
	provision(config: ProjectConfig): Promise<ProvisionResult>
	build(config: ProjectConfig): Promise<BuildArtifacts>
	deploy(artifacts: BuildArtifacts): Promise<DeployResult>
	rollback(deploymentId: string): Promise<void>
	logs(options: LogOptions): AsyncIterable<LogLine>
	status(): Promise<DeploymentStatus>
	/** Restarts the running version in place (same release and data), where the platform can. */
	restart?(): Promise<void>
}

/**
 * Optional adapter extension for commands that require runtime context
 * (project root, app name, region) outside an initial provisioning run.
 */
export interface ContextAwareDeployAdapter extends DeployAdapter {
	setContext(context: {
		projectRoot: string
		appName: string
		region: string | null
	}): void
}

/**
 * Checks whether the provided value is a known deploy platform.
 */
export function isDeployPlatform(value: string): value is DeployPlatform {
	return (DEPLOY_PLATFORMS as readonly string[]).includes(value)
}
