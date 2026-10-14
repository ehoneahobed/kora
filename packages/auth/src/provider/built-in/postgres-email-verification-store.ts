import { ensurePostgresSchema } from '../../postgres/ensure-schema'
import type { EmailVerificationStore, EmailVerificationToken } from './email-verification'

/** A postgres.js tagged-template client. */
export type PostgresEmailVerificationClient = (
	template: TemplateStringsArray,
	...args: unknown[]
) => Promise<Record<string, unknown>[]>

function fromRow(row: Record<string, unknown>): EmailVerificationToken {
	return {
		tokenHash: String(row.token_hash),
		userId: String(row.user_id),
		email: String(row.email),
		createdAt: Number(row.created_at),
		expiresAt: Number(row.expires_at),
	}
}

/** Pending email verifications in the users' Postgres database (`auth_email_verifications`). */
export class PostgresEmailVerificationStore implements EmailVerificationStore {
	private readonly ready: Promise<void>

	constructor(private readonly sql: PostgresEmailVerificationClient) {
		this.ready = ensurePostgresSchema(this.sql, async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS auth_email_verifications (
					token_hash TEXT PRIMARY KEY,
					user_id TEXT NOT NULL,
					email TEXT NOT NULL,
					created_at BIGINT NOT NULL,
					expires_at BIGINT NOT NULL
				)
			`
			await sql`
				CREATE INDEX IF NOT EXISTS idx_auth_email_verifications_user
				ON auth_email_verifications (user_id)
			`
		})
	}

	async store(token: EmailVerificationToken): Promise<void> {
		await this.ready
		await this.sql`
			INSERT INTO auth_email_verifications (token_hash, user_id, email, created_at, expires_at)
			VALUES (${token.tokenHash}, ${token.userId}, ${token.email}, ${token.createdAt}, ${token.expiresAt})
		`
	}

	async take(tokenHash: string): Promise<EmailVerificationToken | null> {
		await this.ready
		const rows = await this.sql`
			DELETE FROM auth_email_verifications WHERE token_hash = ${tokenHash} RETURNING *
		`
		const row = rows[0]
		return row ? fromRow(row) : null
	}

	async countSince(userId: string, since: number): Promise<number> {
		await this.ready
		const rows = await this.sql`
			SELECT COUNT(*) AS n FROM auth_email_verifications WHERE user_id = ${userId} AND created_at >= ${since}
		`
		return Number(rows[0]?.n ?? 0)
	}

	async deleteForUser(userId: string): Promise<void> {
		await this.ready
		await this.sql`DELETE FROM auth_email_verifications WHERE user_id = ${userId}`
	}

	async deleteExpired(now: number): Promise<number> {
		await this.ready
		const rows = await this.sql`
			DELETE FROM auth_email_verifications WHERE expires_at <= ${now} RETURNING token_hash
		`
		return rows.length
	}
}
