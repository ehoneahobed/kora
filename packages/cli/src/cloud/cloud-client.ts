import { KoraCloudError, KoraCloudSignInRequiredError } from '../errors'

export interface CloudOrganization {
	id: string
	name: string
	role: 'owner' | 'member'
}

export interface CloudProject {
	id: string
	organizationId: string
	name: string
	slug: string
	publicUrl: string | null
}

export interface CloudLoginStart {
	loginId: string
	pollSecret: string
	userCode: string
	verificationUrl: string
	expiresIn: number
	interval: number
}

export type CloudLoginPoll =
	| { status: 'pending' }
	| { status: 'approved'; token: string; email: string }

export interface CloudDeploymentState {
	id: string
	status: 'queued' | 'building' | 'deployed' | 'rejected'
	building: boolean
	rejection: { code: string; message: string } | null
	deployment: {
		id: string
		status: 'queued' | 'running' | 'ready' | 'failed' | 'cancelled'
		stage: string
	} | null
	project: { id: string; name: string; slug: string }
	publicUrl: string | null
	consoleUrl: string | null
	/** Problems found in the release's code: they don't stop it, but will hurt in production. */
	findings?: Array<{ code: string; message: string; fix: string; file: string | null }>
	/** Settings production needs that aren't set yet. */
	missingSettings?: Array<{ name: string; description: string | null; secret: boolean }>
}

export interface CloudDeploymentEvent {
	sequence: number
	stage: string
	status: 'started' | 'succeeded' | 'failed'
	code: string
	message: string
}

export interface CloudLogLine {
	time: string
	stream: 'stdout' | 'stderr' | 'platform'
	message: string
}

/**
 * The Kora Cloud API, as the CLI uses it. Every call goes through the same public API the console
 * uses; the CLI holds no provider credentials.
 */
/** A backup or import as the CLI follows it. */
export interface CloudBackup {
	id: string
	status: 'queued' | 'running' | 'verified' | 'failed' | 'expired'
	trigger: string
	failure: string | null
	report: {
		database: { bytes: number; tables: number; rows: number } | null
		kora: { operations: number } | null
		files: { count: number; bytes: number } | null
		checks: Array<{ name: string; ok: boolean; detail: string }>
	} | null
	/** An import waiting for its upload: where to send the file, until when. Owners only. */
	upload?: { url: string; expiresAt: string; method: string } | null
	/** An import only: how many operations whose ids aren't their content hashes the owner accepted. */
	acceptUnverified?: number
}

export class KoraCloudClient {
	public constructor(
		private readonly apiUrl: string,
		private readonly token: string | null,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	public async startLogin(clientName: string): Promise<CloudLoginStart> {
		return await this.request<CloudLoginStart>('POST', '/v1/cli/login', { json: { clientName } })
	}

	public async pollLogin(loginId: string, pollSecret: string): Promise<CloudLoginPoll> {
		return await this.request<CloudLoginPoll>('POST', '/v1/cli/login/poll', {
			json: { loginId, pollSecret },
		})
	}

	public async signOut(): Promise<void> {
		await this.request<unknown>('DELETE', '/v1/cli/token')
	}

	public async organizations(): Promise<CloudOrganization[]> {
		return (await this.request<{ items: CloudOrganization[] }>('GET', '/v1/organizations')).items
	}

	public async projects(): Promise<CloudProject[]> {
		return (await this.request<{ items: CloudProject[] }>('GET', '/v1/projects')).items
	}

	public async createProject(
		organizationId: string,
		name: string,
		slug: string,
	): Promise<CloudProject> {
		return await this.request<CloudProject>('POST', '/v1/projects', {
			json: { organizationId, name, slug },
		})
	}

	/** Uploads a gzipped tar of the source. Returns the id to follow the deployment by. */
	public async uploadSource(
		projectId: string,
		archive: Uint8Array,
		options: { root: string; gitCommit: string | null },
	): Promise<string> {
		const query = new URLSearchParams({ root: options.root })
		if (options.gitCommit) query.set('gitCommit', options.gitCommit)
		const path = `/v1/projects/${encodeURIComponent(projectId)}/cli-deployments?${query.toString()}`
		return (
			await this.request<{ id: string }>('POST', path, {
				body: archive,
				contentType: 'application/gzip',
			})
		).id
	}

	public async deploymentState(cliDeploymentId: string): Promise<CloudDeploymentState> {
		return await this.request<CloudDeploymentState>(
			'GET',
			`/v1/cli-deployments/${encodeURIComponent(cliDeploymentId)}`,
		)
	}

	public async buildLog(cliDeploymentId: string): Promise<string> {
		return (
			(
				await this.request<{ text?: string }>(
					'GET',
					`/v1/cli-deployments/${encodeURIComponent(cliDeploymentId)}/log`,
				)
			).text ?? ''
		)
	}

	public async deploymentEvents(
		deploymentId: string,
		after: number,
	): Promise<CloudDeploymentEvent[]> {
		const response = await this.request<CloudDeploymentEvent[] | { items: CloudDeploymentEvent[] }>(
			'GET',
			`/v1/deployments/${encodeURIComponent(deploymentId)}/events?after=${after}`,
		)
		return Array.isArray(response) ? response : response.items
	}

	public async projectOverview(projectId: string): Promise<{
		production: { publicUrl: string | null; status?: string } | null
		latestDeployment: { status: string } | null
	}> {
		return await this.request('GET', `/v1/projects/${encodeURIComponent(projectId)}/overview`)
	}

	public async logs(projectId: string, sinceMinutes: number): Promise<CloudLogLine[]> {
		return (
			await this.request<{ lines: CloudLogLine[] }>(
				'GET',
				`/v1/projects/${encodeURIComponent(projectId)}/logs?since=${sinceMinutes}`,
			)
		).lines
	}

	/**
	 * Starts an import into the project's production environment. Owners only. `acceptUnverified`
	 * accepts exactly that many operations whose ids aren't their content hashes, the count a
	 * refused attempt reported.
	 */
	public async startImport(
		projectId: string,
		options: { acceptUnverified?: number | undefined } = {},
	): Promise<CloudBackup> {
		return (
			await this.request<{ backup: CloudBackup }>(
				'POST',
				`/v1/projects/${encodeURIComponent(projectId)}/backups/import`,
				{
					json:
						options.acceptUnverified !== undefined
							? { acceptUnverified: options.acceptUnverified }
							: {},
				},
			)
		).backup
	}

	public async backups(projectId: string): Promise<CloudBackup[]> {
		return (
			await this.request<{ backups: CloudBackup[] }>(
				'GET',
				`/v1/projects/${encodeURIComponent(projectId)}/backups`,
			)
		).backups
	}

	private async request<T>(
		method: string,
		path: string,
		options: { json?: unknown; body?: Uint8Array; contentType?: string } = {},
	): Promise<T> {
		const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'kora-cli' }
		if (this.token) headers.authorization = `Bearer ${this.token}`
		let body: string | Uint8Array<ArrayBuffer> | undefined
		if (options.json !== undefined) {
			headers['content-type'] = 'application/json'
			body = JSON.stringify(options.json)
		} else if (options.body) {
			headers['content-type'] = options.contentType ?? 'application/octet-stream'
			body = new Uint8Array(options.body)
		}
		let response: Response
		try {
			response = await this.fetchImpl(`${this.apiUrl}${path}`, {
				method,
				headers,
				...(body === undefined ? {} : { body }),
			})
		} catch (error) {
			throw new KoraCloudError(
				`Couldn't reach Kora Cloud at ${this.apiUrl}: ${error instanceof Error ? error.message : String(error)}. Check your connection and try again.`,
				'unreachable',
				null,
			)
		}
		if (response.status === 204) return undefined as T
		const text = await response.text()
		let parsed: unknown = null
		try {
			parsed = text.length > 0 ? JSON.parse(text) : null
		} catch {
			parsed = null
		}
		if (response.status === 401) throw new KoraCloudSignInRequiredError()
		if (!response.ok) {
			const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error
			const message =
				typeof error?.message === 'string'
					? error.message
					: `Kora Cloud answered ${response.status}.`
			throw new KoraCloudError(
				message,
				typeof error?.code === 'string' ? error.code : `http_${response.status}`,
				response.status,
			)
		}
		return parsed as T
	}
}
