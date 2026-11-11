import { type CloudDeploymentState, KoraCloudClient } from '../../../cloud/cloud-client'
import { readCredentials } from '../../../cloud/credentials'
import { type ProjectLink, readProjectLink, writeProjectLink } from '../../../cloud/project-link'
import { MAX_UPLOAD_BYTES, type PackedSource, packSource } from '../../../cloud/source-archive'
import { KoraCloudError, KoraCloudSignInRequiredError } from '../../../errors'
import { type PromptClient, createPromptClient } from '../../../prompts/prompt-client'
import { type Logger, createLogger } from '../../../utils/logger'
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

const DEFAULT_SYNC_PATH = '/kora-sync'

const STAGE_LABELS: Readonly<Record<string, string>> = {
	preparing: 'Preparing release',
	building: 'Building image',
	provisioning: 'Provisioning environment',
	migrating: 'Preparing the database',
	verifying: 'Verifying the app',
	activating: 'Activating release',
	ready: 'Ready',
}

export interface KoraCloudAdapterOptions {
	/** Builds the API client from the saved sign-in. Replaced in tests. */
	client?: (() => Promise<KoraCloudClient>) | undefined
	prompts?: PromptClient | undefined
	logger?: Logger | undefined
	pack?: ((projectRoot: string) => Promise<PackedSource>) | undefined
	sleep?: ((milliseconds: number) => Promise<void>) | undefined
	pollMs?: number | undefined
	interactive?: boolean | undefined
}

/**
 * Deploys to Kora Cloud. The project's source is uploaded and built there exactly as a push to its
 * production branch would be; nothing runs on this machine but packing the files.
 */
export class KoraCloudAdapter implements ContextAwareDeployAdapter {
	public readonly name = 'kora-cloud' as const
	private projectRoot = process.cwd()
	private appName = 'kora-app'
	private link: ProjectLink | null = null
	private cachedClient: KoraCloudClient | null = null
	private readonly prompts: PromptClient
	private readonly logger: Logger
	private readonly sleep: (milliseconds: number) => Promise<void>

	public constructor(private readonly options: KoraCloudAdapterOptions = {}) {
		this.prompts = options.prompts ?? createPromptClient()
		this.logger = options.logger ?? createLogger()
		this.sleep =
			options.sleep ??
			((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
	}

	public setContext(context: {
		projectRoot: string
		appName: string
		region: string | null
	}): void {
		this.projectRoot = context.projectRoot
		this.appName = context.appName
	}

	public async detect(): Promise<boolean> {
		return true
	}

	public async install(): Promise<void> {
		// Nothing to install: the CLI talks to Kora Cloud's API directly.
	}

	public async authenticate(): Promise<void> {
		await this.client()
	}

	/**
	 * Finds the project this directory deploys to: the one linked in `.kora/cloud.json`, or one
	 * chosen or created now and then linked, so later deploys ask nothing.
	 */
	public async provision(config: ProjectConfig): Promise<ProvisionResult> {
		const client = await this.client()
		this.link = await readProjectLink(this.projectRoot)
		if (this.link) {
			const linked = (await client.projects()).find(
				(project) => project.id === this.link?.projectId,
			)
			if (!linked)
				throw new KoraCloudError(
					`The project linked in .kora/cloud.json (${this.link.projectId}) wasn't found, or you aren't a member of its organization. Delete .kora/cloud.json to link another.`,
					'project_not_found',
					404,
				)
			this.logger.step(`Project: ${linked.name}`)
			return { applicationId: linked.id, databaseId: null, secretsSet: [] }
		}
		const organizations = await client.organizations()
		if (organizations.length === 0)
			throw new KoraCloudError(
				"Your account isn't a member of any organization yet. Ask an owner to invite you.",
				'no_organization',
				403,
			)
		const interactive =
			this.options.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true)
		const [first] = organizations
		let organization = first
		if (organizations.length > 1) {
			if (config.confirm || !interactive)
				throw new KoraCloudError(
					'You belong to more than one organization. Run kora deploy interactively once to link this project.',
					'organization_required',
					null,
				)
			const chosen = await this.prompts.select(
				'Organization',
				organizations.map((entry) => ({ label: entry.name, value: entry.id })),
			)
			organization = organizations.find((entry) => entry.id === chosen) ?? first
		}
		if (!organization)
			throw new KoraCloudError('No organization to deploy to.', 'no_organization', 403)
		const existing = (await client.projects()).filter(
			(project) => project.organizationId === organization.id,
		)
		const sameName = existing.find((project) => project.slug === this.appName)
		let projectId: string
		if (interactive && !config.confirm && existing.length > 0) {
			const choice = await this.prompts.select('Project', [
				{ label: `Create "${this.appName}"`, value: '__new__' },
				...existing.map((project) => ({ label: `Link to ${project.name}`, value: project.id })),
			])
			projectId =
				choice === '__new__'
					? (await client.createProject(organization.id, this.appName, this.appName)).id
					: choice
		} else if (sameName) {
			projectId = sameName.id
		} else {
			projectId = (await client.createProject(organization.id, this.appName, this.appName)).id
			this.logger.step(`Created project ${this.appName} in ${organization.name}`)
		}
		this.link = { organizationId: organization.id, projectId }
		await writeProjectLink(this.projectRoot, this.link)
		this.logger.step('Linked in .kora/cloud.json')
		return { applicationId: projectId, databaseId: null, secretsSet: [] }
	}

	public async build(_config: ProjectConfig): Promise<BuildArtifacts> {
		// Building happens on Kora Cloud, from the uploaded source, in deploy().
		return { clientDirectory: null, serverBundlePath: null, deployDirectory: this.projectRoot }
	}

	public async deploy(_artifacts: BuildArtifacts): Promise<DeployResult> {
		const client = await this.client()
		const link = this.link ?? (await readProjectLink(this.projectRoot))
		if (!link)
			throw new KoraCloudError(
				"This directory isn't linked to a Kora Cloud project. Run kora deploy interactively.",
				'not_linked',
				null,
			)
		const packed = await (this.options.pack ?? packSource)(this.projectRoot)
		if (packed.archive.byteLength > MAX_UPLOAD_BYTES)
			throw new KoraCloudError(
				`The source is ${Math.ceil(packed.archive.byteLength / 1_048_576)} MiB compressed, more than the 64 MiB Kora Cloud accepts. Check that large files are ignored.`,
				'upload_too_large',
				null,
			)
		for (const file of packed.skipped.slice(0, 5)) this.logger.warn(`Not uploaded: ${file}`)
		this.logger.step(
			`Uploading ${packed.files} files (${(packed.archive.byteLength / 1_048_576).toFixed(1)} MiB)${packed.gitCommit ? ` at ${packed.gitCommit.slice(0, 7)}` : ''}`,
		)
		const id = await client.uploadSource(link.projectId, packed.archive, {
			root: packed.root,
			gitCommit: packed.gitCommit,
		})
		const state = await this.follow(client, id)
		const liveUrl = state.publicUrl ?? ''
		const syncUrl = liveUrl ? syncUrlFor(liveUrl) : null
		if (state.consoleUrl) this.logger.step(`Console: ${state.consoleUrl}`)
		this.reportAttention(state)
		return { deploymentId: state.deployment?.id ?? id, liveUrl, syncUrl }
	}

	public async rollback(_deploymentId: string): Promise<void> {
		throw new KoraCloudError(
			"Roll back from the console: open the project's Deployments page and choose Roll back on an earlier deployment.",
			'rollback_in_console',
			null,
		)
	}

	public async *logs(options: LogOptions): AsyncIterable<LogLine> {
		const client = await this.client()
		const link = await readProjectLink(this.projectRoot)
		if (!link) return
		const lines = await client.logs(link.projectId, 60)
		for (const line of lines.slice(-(options.tail ?? 200))) {
			yield {
				timestamp: line.time,
				level: line.stream === 'stderr' ? 'error' : 'info',
				message: line.message,
			}
		}
	}

	public async status(): Promise<DeploymentStatus> {
		const client = await this.client()
		const link = await readProjectLink(this.projectRoot)
		if (!link) return { state: 'unknown', message: 'Not linked to a Kora Cloud project yet.' }
		const overview = await client.projectOverview(link.projectId)
		const status = overview.latestDeployment?.status
		const liveUrl = overview.production?.publicUrl ?? undefined
		const state =
			status === 'ready'
				? 'healthy'
				: status === 'failed'
					? 'failed'
					: status
						? 'pending'
						: 'unknown'
		return {
			state,
			message: status ? `Latest deployment: ${status}` : 'Not deployed yet.',
			...(liveUrl ? { liveUrl } : {}),
		}
	}

	/**
	 * What needs attention after a successful deploy: settings production still needs, and
	 * problems found in the code. Said once, plainly, with where to fix each.
	 */
	private reportAttention(state: CloudDeploymentState): void {
		const missing = state.missingSettings ?? []
		if (missing.length > 0) {
			this.logger.warn(
				`${missing.length === 1 ? "A setting production needs isn't" : `${missing.length} settings production needs aren't`} set:`,
			)
			for (const setting of missing)
				this.logger.step(
					`${setting.name}${setting.secret ? ' (secret)' : ''}${setting.description ? `: ${setting.description}` : ''}`,
				)
			const settings = state.consoleUrl?.replace(/\/deployments\/.*$/, '/settings')
			if (settings)
				this.logger.step(
					`Set ${missing.length === 1 ? 'it' : 'them'} at ${settings}, then deploy again.`,
				)
		}
		for (const finding of state.findings ?? []) {
			this.logger.warn(finding.message)
			this.logger.step(`Fix: ${finding.fix}${finding.file ? ` (${finding.file})` : ''}`)
		}
	}

	/** Prints each stage as Kora Cloud reports it, until the deployment is ready or refused. */
	private async follow(client: KoraCloudClient, id: string): Promise<CloudDeploymentState> {
		const pollMs = this.options.pollMs ?? 2_000
		let announcedBuild = false
		let cursor = 0
		for (;;) {
			const state = await client.deploymentState(id)
			if (state.status === 'rejected') {
				const log =
					state.rejection?.code === 'build_failed' ? await client.buildLog(id).catch(() => '') : ''
				if (log) {
					this.logger.blank()
					for (const line of log.trimEnd().split('\n').slice(-40)) this.logger.step(line)
					this.logger.blank()
				}
				throw new KoraCloudError(
					state.rejection?.message ?? 'Kora Cloud refused the deployment.',
					state.rejection?.code ?? 'rejected',
					null,
				)
			}
			if (state.building && !announcedBuild && !state.deployment) {
				this.logger.step('Building image on Kora Cloud...')
				announcedBuild = true
			}
			if (state.deployment) {
				for (const event of await client.deploymentEvents(state.deployment.id, cursor)) {
					cursor = Math.max(cursor, event.sequence)
					if (event.status === 'started')
						this.logger.step(`${STAGE_LABELS[event.stage] ?? event.stage}...`)
					if (event.status === 'failed') this.logger.error(event.message)
				}
				if (state.deployment.status === 'ready') return state
				if (state.deployment.status === 'failed' || state.deployment.status === 'cancelled') {
					throw new KoraCloudError(
						`The deployment ${state.deployment.status === 'failed' ? 'failed' : 'was cancelled'}. Production still runs the previous release.${state.consoleUrl ? ` Details: ${state.consoleUrl}` : ''}`,
						`deployment_${state.deployment.status}`,
						null,
					)
				}
			}
			await this.sleep(pollMs)
		}
	}

	private async client(): Promise<KoraCloudClient> {
		if (this.cachedClient) return this.cachedClient
		if (this.options.client) {
			this.cachedClient = await this.options.client()
			return this.cachedClient
		}
		const credentials = await readCredentials()
		if (!credentials) throw new KoraCloudSignInRequiredError()
		this.cachedClient = new KoraCloudClient(credentials.apiUrl, credentials.token)
		return this.cachedClient
	}
}

function syncUrlFor(publicUrl: string): string {
	const url = new URL(publicUrl)
	url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
	url.pathname = DEFAULT_SYNC_PATH
	return url.toString()
}
