import { ensurePostgresSchema } from '../../postgres/ensure-schema'
import {
	EMAIL_VERIFICATION_TABLES,
	type OneTimeToken,
	type OneTimeTokenStore,
	type OneTimeTokenTables,
	PASSWORD_RESET_TABLES,
	assertTableNames,
} from './one-time-tokens'

/** A postgres.js tagged-template client. */
export type PostgresOneTimeTokenClient = (
	template: TemplateStringsArray,
	...args: unknown[]
) => Promise<Record<string, unknown>[]>

function fromRow(row: Record<string, unknown>): OneTimeToken {
	return {
		tokenHash: String(row.token_hash),
		userId: String(row.user_id),
		email: String(row.email),
		createdAt: Number(row.created_at),
		expiresAt: Number(row.expires_at),
	}
}

/**
 * A tagged template that writes the store's table names where the SQL says `$TOKENS` and
 * `$SENDS` (identifiers cannot be bound as parameters; the names are checked identifiers).
 * Each rewritten template is kept, so a statement is the same array every time.
 */
function withTables(
	sql: PostgresOneTimeTokenClient,
	tables: OneTimeTokenTables,
): PostgresOneTimeTokenClient {
	const templates = new Map<TemplateStringsArray, TemplateStringsArray>()
	return (strings, ...args) => {
		let rewritten = templates.get(strings)
		if (!rewritten) {
			const parts = strings.map((part) =>
				part.replaceAll('$TOKENS', tables.tokens).replaceAll('$SENDS', tables.sends),
			)
			rewritten = Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray
			templates.set(strings, rewritten)
		}
		return sql(rewritten, ...args)
	}
}

/** Pending emailed tokens of one kind in the users' Postgres database. */
export class PostgresOneTimeTokenStore implements OneTimeTokenStore {
	private readonly ready: Promise<void>
	private readonly sql: PostgresOneTimeTokenClient

	constructor(client: PostgresOneTimeTokenClient, tables: OneTimeTokenTables) {
		assertTableNames(tables)
		this.sql = withTables(client, tables)
		this.ready = ensurePostgresSchema(client, async (ddl) => {
			const sql = withTables(ddl, tables)
			await sql`
				CREATE TABLE IF NOT EXISTS $TOKENS (
					token_hash TEXT PRIMARY KEY,
					user_id TEXT NOT NULL,
					email TEXT NOT NULL,
					created_at BIGINT NOT NULL,
					expires_at BIGINT NOT NULL
				)
			`
			await sql`CREATE INDEX IF NOT EXISTS idx_$TOKENS_user ON $TOKENS (user_id)`
			await sql`CREATE INDEX IF NOT EXISTS idx_$TOKENS_expires ON $TOKENS (expires_at)`
			await sql`
				CREATE TABLE IF NOT EXISTS $SENDS (
					user_id TEXT PRIMARY KEY,
					window_start BIGINT NOT NULL,
					count INTEGER NOT NULL
				)
			`
		})
	}

	async store(token: OneTimeToken): Promise<void> {
		await this.ready
		await this.sql`
			INSERT INTO $TOKENS (token_hash, user_id, email, created_at, expires_at)
			VALUES (${token.tokenHash}, ${token.userId}, ${token.email}, ${token.createdAt}, ${token.expiresAt})
		`
	}

	async take(tokenHash: string, userId?: string): Promise<OneTimeToken | null> {
		await this.ready
		const rows =
			userId === undefined
				? await this.sql`DELETE FROM $TOKENS WHERE token_hash = ${tokenHash} RETURNING *`
				: await this.sql`
						DELETE FROM $TOKENS WHERE token_hash = ${tokenHash} AND user_id = ${userId} RETURNING *
					`
		const row = rows[0]
		return row ? fromRow(row) : null
	}

	async get(tokenHash: string): Promise<OneTimeToken | null> {
		await this.ready
		const rows = await this.sql`SELECT * FROM $TOKENS WHERE token_hash = ${tokenHash}`
		const row = rows[0]
		return row ? fromRow(row) : null
	}

	async countSend(userId: string, now: number, windowMs: number): Promise<number> {
		await this.ready
		// One upsert: the row lock serializes concurrent sends, so each gets its own count.
		// SET expressions read the row as it was, so both CASEs test the old window.
		const expired = now - windowMs
		const rows = await this.sql`
			INSERT INTO $SENDS (user_id, window_start, count)
			VALUES (${userId}, ${now}, 1)
			ON CONFLICT (user_id) DO UPDATE SET
				count = CASE WHEN $SENDS.window_start <= ${expired}
					THEN 1 ELSE $SENDS.count + 1 END,
				window_start = CASE WHEN $SENDS.window_start <= ${expired}
					THEN excluded.window_start ELSE $SENDS.window_start END
			RETURNING count
		`
		return Number(rows[0]?.count ?? 1)
	}

	async deleteForUser(userId: string): Promise<void> {
		await this.ready
		await this.sql`DELETE FROM $TOKENS WHERE user_id = ${userId}`
		await this.sql`DELETE FROM $SENDS WHERE user_id = ${userId}`
	}

	async deleteExpired(now: number): Promise<number> {
		await this.ready
		const rows = await this.sql`DELETE FROM $TOKENS WHERE expires_at <= ${now} RETURNING token_hash`
		return rows.length
	}
}

/** Pending email verifications in the users' Postgres database (`auth_email_verifications`). */
export class PostgresEmailVerificationStore extends PostgresOneTimeTokenStore {
	constructor(client: PostgresOneTimeTokenClient) {
		super(client, EMAIL_VERIFICATION_TABLES)
	}
}

/** Pending password resets in the users' Postgres database (`auth_password_resets`). */
export class PostgresPasswordResetStore extends PostgresOneTimeTokenStore {
	constructor(client: PostgresOneTimeTokenClient) {
		super(client, PASSWORD_RESET_TABLES)
	}
}
