import { randomUUID } from 'node:crypto'
import { DuplicateLinkedIdentityError, type LinkedIdentityStore } from './linked-identity-store'
import type { LinkedIdentity, OAuthState, OAuthStateStore } from './oauth-types'

interface PostgresClient {
	begin<T>(fn: (sql: PostgresClient) => Promise<T>): Promise<T>
	(template: TemplateStringsArray, ...args: unknown[]): Promise<Record<string, unknown>[]>
}

interface OAuthStateRow {
	state: string
	provider: string
	redirect_uri: string
	created_at: string | number
	expires_at: string | number
	metadata_json: string | null
	code_verifier: string | null
}

interface LinkedIdentityRow {
	id: string
	user_id: string
	provider: string
	provider_user_id: string
	email: string | null
	linked_at: string | number
}

export class PostgresOAuthStateStore implements OAuthStateStore {
	private readonly sql: PostgresClient
	private readonly ready: Promise<void>

	constructor(sql: PostgresClient) {
		this.sql = sql
		this.ready = this.ensureTables()
	}

	async store(state: OAuthState): Promise<void> {
		await this.ready
		await this.sql`
			INSERT INTO auth_oauth_states
				(state, provider, redirect_uri, created_at, expires_at, metadata_json, code_verifier)
			VALUES (
				${state.state},
				${state.provider},
				${state.redirectUri},
				${state.createdAt},
				${state.expiresAt},
				${state.metadata ? JSON.stringify(state.metadata) : null},
				${state.codeVerifier ?? null}
			)
			ON CONFLICT (state) DO UPDATE SET
				provider = EXCLUDED.provider,
				redirect_uri = EXCLUDED.redirect_uri,
				created_at = EXCLUDED.created_at,
				expires_at = EXCLUDED.expires_at,
				metadata_json = EXCLUDED.metadata_json,
				code_verifier = EXCLUDED.code_verifier
		`
	}

	async consume(stateValue: string): Promise<OAuthState | null> {
		await this.ready
		return this.sql.begin(async (tx) => {
			const rows = (await tx`
				DELETE FROM auth_oauth_states
				WHERE state = ${stateValue}
				RETURNING *
			`) as unknown as OAuthStateRow[]

			const row = rows[0]
			if (!row || Date.now() > Number(row.expires_at)) {
				return null
			}
			return rowToOAuthState(row)
		})
	}

	async cleanExpired(): Promise<number> {
		await this.ready
		const rows = await this.sql`
			DELETE FROM auth_oauth_states
			WHERE expires_at < ${Date.now()}
			RETURNING state
		`
		return rows.length
	}

	private async ensureTables(): Promise<void> {
		await this.sql`
			CREATE TABLE IF NOT EXISTS auth_oauth_states (
				state TEXT PRIMARY KEY,
				provider TEXT NOT NULL,
				redirect_uri TEXT NOT NULL,
				created_at BIGINT NOT NULL,
				expires_at BIGINT NOT NULL,
				metadata_json TEXT,
				code_verifier TEXT
			)
		`

		await this.sql`
			CREATE INDEX IF NOT EXISTS idx_auth_oauth_states_expires_at
				ON auth_oauth_states(expires_at)
		`
	}
}

export class PostgresLinkedIdentityStore implements LinkedIdentityStore {
	private readonly sql: PostgresClient
	private readonly ready: Promise<void>

	constructor(sql: PostgresClient) {
		this.sql = sql
		this.ready = this.ensureTables()
	}

	async findByProvider(provider: string, providerUserId: string): Promise<LinkedIdentity | null> {
		await this.ready
		const rows = (await this.sql`
			SELECT * FROM auth_linked_identities
			WHERE provider = ${provider} AND provider_user_id = ${providerUserId}
		`) as unknown as LinkedIdentityRow[]

		return rows[0] ? rowToLinkedIdentity(rows[0]) : null
	}

	async findByUser(userId: string): Promise<LinkedIdentity[]> {
		await this.ready
		const rows = (await this.sql`
			SELECT * FROM auth_linked_identities
			WHERE user_id = ${userId}
			ORDER BY linked_at ASC
		`) as unknown as LinkedIdentityRow[]

		return rows.map(rowToLinkedIdentity)
	}

	async create(params: {
		userId: string
		provider: string
		providerUserId: string
		email: string | null
	}): Promise<LinkedIdentity> {
		await this.ready
		const identity: LinkedIdentity = {
			id: randomUUID(),
			userId: params.userId,
			provider: params.provider,
			providerUserId: params.providerUserId,
			email: params.email,
			linkedAt: Date.now(),
		}

		try {
			await this.sql`
				INSERT INTO auth_linked_identities
					(id, user_id, provider, provider_user_id, email, linked_at)
				VALUES (
					${identity.id},
					${identity.userId},
					${identity.provider},
					${identity.providerUserId},
					${identity.email},
					${identity.linkedAt}
				)
			`
		} catch (error) {
			if (isUniqueViolation(error)) {
				throw new DuplicateLinkedIdentityError(params.provider)
			}
			throw error
		}

		return identity
	}

	async delete(userId: string, provider: string): Promise<void> {
		await this.ready
		await this.sql`
			DELETE FROM auth_linked_identities
			WHERE user_id = ${userId} AND provider = ${provider}
		`
	}

	private async ensureTables(): Promise<void> {
		await this.sql`
			CREATE TABLE IF NOT EXISTS auth_linked_identities (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				provider TEXT NOT NULL,
				provider_user_id TEXT NOT NULL,
				email TEXT,
				linked_at BIGINT NOT NULL,
				UNIQUE(provider, provider_user_id),
				UNIQUE(user_id, provider)
			)
		`

		await this.sql`
			CREATE INDEX IF NOT EXISTS idx_auth_linked_identities_user_id
				ON auth_linked_identities(user_id)
		`
	}
}

export async function createPostgresOAuthStateStore(options: {
	connectionString: string
}): Promise<PostgresOAuthStateStore> {
	const postgresClient = await loadPostgresDeps()
	const sql = postgresClient(options.connectionString) as unknown as PostgresClient
	return new PostgresOAuthStateStore(sql)
}

export async function createPostgresLinkedIdentityStore(options: {
	connectionString: string
}): Promise<PostgresLinkedIdentityStore> {
	const postgresClient = await loadPostgresDeps()
	const sql = postgresClient(options.connectionString) as unknown as PostgresClient
	return new PostgresLinkedIdentityStore(sql)
}

export async function createPostgresOAuthStores(options: { connectionString: string }): Promise<{
	stateStore: PostgresOAuthStateStore
	linkedIdentityStore: PostgresLinkedIdentityStore
}> {
	const postgresClient = await loadPostgresDeps()
	const sql = postgresClient(options.connectionString) as unknown as PostgresClient
	return {
		stateStore: new PostgresOAuthStateStore(sql),
		linkedIdentityStore: new PostgresLinkedIdentityStore(sql),
	}
}

async function loadPostgresDeps(): Promise<(connectionString: string) => unknown> {
	try {
		const dynamicImport = new Function('specifier', 'return import(specifier)') as (
			specifier: string,
		) => Promise<unknown>

		const postgresMod = (await dynamicImport('postgres')) as { default: (cs: string) => unknown }
		return postgresMod.default
	} catch {
		throw new Error(
			'PostgreSQL OAuth stores require the "postgres" package. Install it in your project dependencies.',
		)
	}
}

function rowToOAuthState(row: OAuthStateRow): OAuthState {
	return {
		state: row.state,
		provider: row.provider,
		redirectUri: row.redirect_uri,
		createdAt: Number(row.created_at),
		expiresAt: Number(row.expires_at),
		metadata: parseMetadata(row.metadata_json),
		codeVerifier: row.code_verifier ?? undefined,
	}
}

function parseMetadata(value: string | null): Record<string, unknown> | undefined {
	if (!value) return undefined
	const parsed = JSON.parse(value) as unknown
	return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: undefined
}

function rowToLinkedIdentity(row: LinkedIdentityRow): LinkedIdentity {
	return {
		id: row.id,
		userId: row.user_id,
		provider: row.provider,
		providerUserId: row.provider_user_id,
		email: row.email,
		linkedAt: Number(row.linked_at),
	}
}

function isUniqueViolation(error: unknown): boolean {
	if (!(error instanceof Error)) return false
	const code = (error as Error & { code?: string }).code
	return (
		code === '23505' ||
		error.message.includes('unique constraint') ||
		error.message.includes('duplicate key')
	)
}
