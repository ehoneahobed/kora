import type {
	BuildArtifacts,
	ContextAwareDeployAdapter,
	DeployPlatform,
	DeployResult,
	DeploymentStatus,
	LogLine,
	LogOptions,
	ProjectConfig,
	ProvisionResult,
} from './adapter'

/**
 * Lightweight scaffold adapter used for platforms not yet implemented.
 * It provides explicit, deterministic errors while preserving the shared
 * adapter contract and command wiring across all platforms.
 */
export class StubDeployAdapter implements ContextAwareDeployAdapter {
	public readonly name: DeployPlatform
	private readonly contextLabel: string

	public constructor(platform: DeployPlatform) {
		this.name = platform
		this.contextLabel = `Deploy adapter "${platform}" is not implemented yet.`
	}

	public setContext(_context: {
		projectRoot: string
		appName: string
		region: string | null
	}): void {
		// Context is intentionally ignored for stub implementations.
	}

	public async detect(): Promise<boolean> {
		return false
	}

	public async install(): Promise<void> {
		throw this.notImplementedError()
	}

	public async authenticate(): Promise<void> {
		throw this.notImplementedError()
	}

	public async provision(_config: ProjectConfig): Promise<ProvisionResult> {
		throw this.notImplementedError()
	}

	public async build(_config: ProjectConfig): Promise<BuildArtifacts> {
		throw this.notImplementedError()
	}

	public async deploy(_artifacts: BuildArtifacts): Promise<DeployResult> {
		throw this.notImplementedError()
	}

	public async rollback(_deploymentId: string): Promise<void> {
		throw this.notImplementedError()
	}

	public logs(_options: LogOptions): AsyncIterable<LogLine> {
		throw this.notImplementedError()
	}

	public async status(): Promise<DeploymentStatus> {
		return {
			state: 'unknown',
			message: this.notImplementedMessage(),
		}
	}

	private notImplementedError(): Error {
		return new Error(this.notImplementedMessage())
	}

	private notImplementedMessage(): string {
		return `${this.contextLabel} Start with --platform fly for now.`
	}
}
