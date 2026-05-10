import { randomUUID } from 'node:crypto'
import { DuplicateLinkedIdentityError, type LinkedIdentityStore } from './linked-identity-store'
import type { LinkedIdentity, OAuthState, OAuthStateStore } from './oauth-types'

interface SqliteDatabase {
	pragma(source: string): unknown
	exec(source: string): void
	prepare(source: string): {
		run(...params: unknown[]): { changes?: number } | unknown
		get(...params: unknown[]): unknown
		all(...params: unknown[]): unknown[]
	}
	transaction<T>(fn: () => T): () => T
}

interface OAuthStateRow {
	state: string
	provider: string
	redirect_uri: string
	created_at: number
	expires_at: number
	metadata_json: string | null
	code_verifier: string | null
}

interface LinkedIdentityRow {
	id: string
	user_id: string
	provider: string
	provider_user_id: string
	email: string | null
	linked_at: number
}

export class SqliteOAuthStateStore implements OAuthStateStore {
	private readonly db: SqliteDatabase

	constructor(db: SqliteDatabase) {
		this.db = db
		this.db.pragma('journal_mode = WAL')
		this.ensureTables()
	}

	async store(state: OAuthState): Promise<void> {
		this.db
			.prepare(`
				INSERT OR REPLACE INTO auth_oauth_states
					(state, provider, redirect_uri, created_at, expires_at, metadata_json, code_verifier)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`)
			.run(
				state.state,
				state.provider,
				state.redirectUri,
				state.createdAt,
				state.expiresAt,
				state.metadata ? JSON.stringify(state.metadata) : null,
				state.codeVerifier ?? null,
			)
	}

	async consume(stateValue: string): Promise<OAuthState | null> {
		const consumeInTransaction = this.db.transaction(() => {
			const row = this.db
				.prepare('SELECT * FROM auth_oauth_states WHERE state = ?')
				.get(stateValue) as OAuthStateRow | undefined

			if (!row) return null

			this.db.prepare('DELETE FROM auth_oauth_states WHERE state = ?').run(stateValue)
			if (Date.now() > row.expires_at) return null

			return rowToOAuthState(row)
		})

		return consumeInTransaction()
	}

	async cleanExpired(): Promise<number> {
		const result = this.db
			.prepare('DELETE FROM auth_oauth_states WHERE expires_at < ?')
			.run(Date.now()) as { changes?: number }
		return result.changes ?? 0
	}

	private ensureTables(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS auth_oauth_states (
				state TEXT PRIMARY KEY,
				provider TEXT NOT NULL,
				redirect_uri TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				metadata_json TEXT,
				code_verifier TEXT
			);

			CREATE INDEX IF NOT EXISTS idx_auth_oauth_states_expires_at
				ON auth_oauth_states(expires_at);
		`)
	}
}

export class SqliteLinkedIdentityStore implements LinkedIdentityStore {
	private readonly db: SqliteDatabase

	constructor(db: SqliteDatabase) {
		this.db = db
		this.db.pragma('journal_mode = WAL')
		this.ensureTables()
	}

	async findByProvider(provider: string, providerUserId: string): Promise<LinkedIdentity | null> {
		const row = this.db
			.prepare(`
				SELECT * FROM auth_linked_identities
				WHERE provider = ? AND provider_user_id = ?
			`)
			.get(provider, providerUserId) as LinkedIdentityRow | undefined

		return row ? rowToLinkedIdentity(row) : null
	}

	async findByUser(userId: string): Promise<LinkedIdentity[]> {
		const rows = this.db
			.prepare(`
				SELECT * FROM auth_linked_identities
				WHERE user_id = ?
				ORDER BY linked_at ASC
			`)
			.all(userId) as LinkedIdentityRow[]

		return rows.map(rowToLinkedIdentity)
	}

	async create(params: {
		userId: string
		provider: string
		providerUserId: string
		email: string | null
	}): Promise<LinkedIdentity> {
		const identity: LinkedIdentity = {
			id: randomUUID(),
			userId: params.userId,
			provider: params.provider,
			providerUserId: params.providerUserId,
			email: params.email,
			linkedAt: Date.now(),
		}

		try {
			this.db
				.prepare(`
					INSERT INTO auth_linked_identities
						(id, user_id, provider, provider_user_id, email, linked_at)
					VALUES (?, ?, ?, ?, ?, ?)
				`)
				.run(
					identity.id,
					identity.userId,
					identity.provider,
					identity.providerUserId,
					identity.email,
					identity.linkedAt,
				)
		} catch (error) {
			if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
				throw new DuplicateLinkedIdentityError(params.provider)
			}
			throw error
		}

		return identity
	}

	async delete(userId: string, provider: string): Promise<void> {
		this.db
			.prepare('DELETE FROM auth_linked_identities WHERE user_id = ? AND provider = ?')
			.run(userId, provider)
	}

	private ensureTables(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS auth_linked_identities (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				provider TEXT NOT NULL,
				provider_user_id TEXT NOT NULL,
				email TEXT,
				linked_at INTEGER NOT NULL,
				UNIQUE(provider, provider_user_id),
				UNIQUE(user_id, provider)
			);

			CREATE INDEX IF NOT EXISTS idx_auth_linked_identities_user_id
				ON auth_linked_identities(user_id);
		`)
	}
}

export async function createSqliteOAuthStateStore(options: {
	filename: string
}): Promise<SqliteOAuthStateStore> {
	const Database = await loadBetterSqlite3()
	const db = new Database(options.filename)
	return new SqliteOAuthStateStore(db as unknown as SqliteDatabase)
}

export async function createSqliteLinkedIdentityStore(options: {
	filename: string
}): Promise<SqliteLinkedIdentityStore> {
	const Database = await loadBetterSqlite3()
	const db = new Database(options.filename)
	return new SqliteLinkedIdentityStore(db as unknown as SqliteDatabase)
}

export async function createSqliteOAuthStores(options: { filename: string }): Promise<{
	stateStore: SqliteOAuthStateStore
	linkedIdentityStore: SqliteLinkedIdentityStore
}> {
	const Database = await loadBetterSqlite3()
	const db = new Database(options.filename) as unknown as SqliteDatabase
	return {
		stateStore: new SqliteOAuthStateStore(db),
		linkedIdentityStore: new SqliteLinkedIdentityStore(db),
	}
}

async function loadBetterSqlite3(): Promise<new (filename: string) => unknown> {
	try {
		const { createRequire } = await import('node:module')
		const require = createRequire(import.meta.url)
		return require('better-sqlite3') as new (
			filename: string,
		) => unknown
	} catch {
		throw new Error(
			'SQLite OAuth stores require the "better-sqlite3" package. Install it in your project dependencies.',
		)
	}
}

function rowToOAuthState(row: OAuthStateRow): OAuthState {
	return {
		state: row.state,
		provider: row.provider,
		redirectUri: row.redirect_uri,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
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
		linkedAt: row.linked_at,
	}
}
