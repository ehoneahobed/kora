export const DEPLOY_PLATFORMS = ['fly', 'railway', 'render', 'docker', 'kora-cloud'] as const

export type DeployPlatform = (typeof DEPLOY_PLATFORMS)[number]

export interface ProjectConfig {
	projectRoot: string
	appName: string
	region: string | null
	environment: 'preview' | 'production'
	confirm: boolean
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
	liveUrl: string
	syncUrl: string | null
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
