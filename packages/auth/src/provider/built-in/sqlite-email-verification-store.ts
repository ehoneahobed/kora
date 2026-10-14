import type { EmailVerificationStore, EmailVerificationToken } from './email-verification'

/** The parts of a better-sqlite3 database the store uses. */
export interface SqliteEmailVerificationDatabase {
	exec(source: string): void
	prepare(source: string): {
		run(...params: unknown[]): { changes: number }
		get(...params: unknown[]): unknown
	}
}

interface Row {
	token_hash: string
	user_id: string
	email: string
	created_at: number
	expires_at: number
}

function fromRow(row: Row): EmailVerificationToken {
	return {
		tokenHash: row.token_hash,
		userId: row.user_id,
		email: row.email,
		createdAt: Number(row.created_at),
		expiresAt: Number(row.expires_at),
	}
}

/** Pending email verifications in the users' SQLite database (`auth_email_verifications`). */
export class SqliteEmailVerificationStore implements EmailVerificationStore {
	constructor(private readonly db: SqliteEmailVerificationDatabase) {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS auth_email_verifications (
				token_hash TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				email TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_auth_email_verifications_user ON auth_email_verifications(user_id);
			CREATE TABLE IF NOT EXISTS auth_email_verification_sends (
				user_id TEXT PRIMARY KEY,
				window_start INTEGER NOT NULL,
				count INTEGER NOT NULL
			);
		`)
	}

	async store(token: EmailVerificationToken): Promise<void> {
		this.db
			.prepare(
				'INSERT INTO auth_email_verifications (token_hash, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
			)
			.run(token.tokenHash, token.userId, token.email, token.createdAt, token.expiresAt)
	}

	async take(tokenHash: string): Promise<EmailVerificationToken | null> {
		// DELETE ... RETURNING: one statement, so two takes of one token cannot both get it.
		const row = this.db
			.prepare('DELETE FROM auth_email_verifications WHERE token_hash = ? RETURNING *')
			.get(tokenHash) as Row | undefined
		return row ? fromRow(row) : null
	}

	async countSend(userId: string, now: number, windowMs: number): Promise<number> {
		// One upsert statement: SQLite runs it atomically, so concurrent sends count apart.
		// SET expressions read the row as it was, so both CASEs test the old window.
		const row = this.db
			.prepare(
				`INSERT INTO auth_email_verification_sends (user_id, window_start, count) VALUES (?, ?, 1)
				ON CONFLICT(user_id) DO UPDATE SET
					count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
					window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
				RETURNING count`,
			)
			.get(userId, now, now - windowMs, now - windowMs) as { count: number } | undefined
		return Number(row?.count ?? 1)
	}

	async deleteForUser(userId: string): Promise<void> {
		this.db.prepare('DELETE FROM auth_email_verifications WHERE user_id = ?').run(userId)
		this.db.prepare('DELETE FROM auth_email_verification_sends WHERE user_id = ?').run(userId)
	}

	async deleteExpired(now: number): Promise<number> {
		return this.db.prepare('DELETE FROM auth_email_verifications WHERE expires_at <= ?').run(now)
			.changes
	}
}
