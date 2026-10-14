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
			await sql`
				CREATE TABLE IF NOT EXISTS auth_email_verification_sends (
					user_id TEXT PRIMARY KEY,
					window_start BIGINT NOT NULL,
					count INTEGER NOT NULL
				)
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

	async take(tokenHash: string, userId?: string): Promise<EmailVerificationToken | null> {
		await this.ready
		const rows =
			userId === undefined
				? await this.sql`
						DELETE FROM auth_email_verifications WHERE token_hash = ${tokenHash} RETURNING *
					`
				: await this.sql`
						DELETE FROM auth_email_verifications
						WHERE token_hash = ${tokenHash} AND user_id = ${userId}
						RETURNING *
					`
		const row = rows[0]
		return row ? fromRow(row) : null
	}

	async get(tokenHash: string): Promise<EmailVerificationToken | null> {
		await this.ready
		const rows = await this
			.sql`SELECT * FROM auth_email_verifications WHERE token_hash = ${tokenHash}`
		const row = rows[0]
		return row ? fromRow(row) : null
	}

	async countSend(userId: string, now: number, windowMs: number): Promise<number> {
		await this.ready
		// One upsert: the row lock serializes concurrent sends, so each gets its own count.
		// SET expressions read the row as it was, so both CASEs test the old window.
		const expired = now - windowMs
		const rows = await this.sql`
			INSERT INTO auth_email_verification_sends (user_id, window_start, count)
			VALUES (${userId}, ${now}, 1)
			ON CONFLICT (user_id) DO UPDATE SET
				count = CASE WHEN auth_email_verification_sends.window_start <= ${expired}
					THEN 1 ELSE auth_email_verification_sends.count + 1 END,
				window_start = CASE WHEN auth_email_verification_sends.window_start <= ${expired}
					THEN excluded.window_start ELSE auth_email_verification_sends.window_start END
			RETURNING count
		`
		return Number(rows[0]?.count ?? 1)
	}

	async deleteForUser(userId: string): Promise<void> {
		await this.ready
		await this.sql`DELETE FROM auth_email_verifications WHERE user_id = ${userId}`
		await this.sql`DELETE FROM auth_email_verification_sends WHERE user_id = ${userId}`
	}

	async deleteExpired(now: number): Promise<number> {
		await this.ready
		const rows = await this.sql`
			DELETE FROM auth_email_verifications WHERE expires_at <= ${now} RETURNING token_hash
		`
		return rows.length
	}
}
