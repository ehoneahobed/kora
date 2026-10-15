import {
	EMAIL_VERIFICATION_TABLES,
	type OneTimeToken,
	type OneTimeTokenStore,
	type OneTimeTokenTables,
	PASSWORD_RESET_TABLES,
	assertTableNames,
} from './one-time-tokens'

/** The parts of a better-sqlite3 database the store uses. */
export interface SqliteOneTimeTokenDatabase {
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

function fromRow(row: Row): OneTimeToken {
	return {
		tokenHash: row.token_hash,
		userId: row.user_id,
		email: row.email,
		createdAt: Number(row.created_at),
		expiresAt: Number(row.expires_at),
	}
}

/** Pending emailed tokens of one kind in the users' SQLite database. */
export class SqliteOneTimeTokenStore implements OneTimeTokenStore {
	private readonly t: OneTimeTokenTables

	constructor(
		private readonly db: SqliteOneTimeTokenDatabase,
		tables: OneTimeTokenTables,
	) {
		assertTableNames(tables)
		this.t = tables
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS ${this.t.tokens} (
				token_hash TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				email TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_${this.t.tokens}_user ON ${this.t.tokens}(user_id);
			CREATE INDEX IF NOT EXISTS idx_${this.t.tokens}_expires ON ${this.t.tokens}(expires_at);
			CREATE TABLE IF NOT EXISTS ${this.t.sends} (
				user_id TEXT PRIMARY KEY,
				window_start INTEGER NOT NULL,
				count INTEGER NOT NULL
			);
		`)
	}

	async store(token: OneTimeToken): Promise<void> {
		this.db
			.prepare(
				`INSERT INTO ${this.t.tokens} (token_hash, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
			)
			.run(token.tokenHash, token.userId, token.email, token.createdAt, token.expiresAt)
	}

	async take(tokenHash: string, userId?: string): Promise<OneTimeToken | null> {
		// DELETE ... RETURNING: one statement, so two takes of one token cannot both get it.
		const row = (
			userId === undefined
				? this.db
						.prepare(`DELETE FROM ${this.t.tokens} WHERE token_hash = ? RETURNING *`)
						.get(tokenHash)
				: this.db
						.prepare(
							`DELETE FROM ${this.t.tokens} WHERE token_hash = ? AND user_id = ? RETURNING *`,
						)
						.get(tokenHash, userId)
		) as Row | undefined
		return row ? fromRow(row) : null
	}

	async get(tokenHash: string): Promise<OneTimeToken | null> {
		const row = this.db
			.prepare(`SELECT * FROM ${this.t.tokens} WHERE token_hash = ?`)
			.get(tokenHash) as Row | undefined
		return row ? fromRow(row) : null
	}

	async countSend(userId: string, now: number, windowMs: number): Promise<number> {
		// One upsert statement: SQLite runs it atomically, so concurrent sends count apart.
		// SET expressions read the row as it was, so both CASEs test the old window.
		const row = this.db
			.prepare(
				`INSERT INTO ${this.t.sends} (user_id, window_start, count) VALUES (?, ?, 1)
				ON CONFLICT(user_id) DO UPDATE SET
					count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
					window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
				RETURNING count`,
			)
			.get(userId, now, now - windowMs, now - windowMs) as { count: number } | undefined
		return Number(row?.count ?? 1)
	}

	async deleteForUser(userId: string): Promise<void> {
		this.db.prepare(`DELETE FROM ${this.t.tokens} WHERE user_id = ?`).run(userId)
		this.db.prepare(`DELETE FROM ${this.t.sends} WHERE user_id = ?`).run(userId)
	}

	async deleteExpired(now: number): Promise<number> {
		return this.db.prepare(`DELETE FROM ${this.t.tokens} WHERE expires_at <= ?`).run(now).changes
	}
}

/** Pending email verifications in the users' SQLite database (`auth_email_verifications`). */
export class SqliteEmailVerificationStore extends SqliteOneTimeTokenStore {
	constructor(db: SqliteOneTimeTokenDatabase) {
		super(db, EMAIL_VERIFICATION_TABLES)
	}
}

/** Pending password resets in the users' SQLite database (`auth_password_resets`). */
export class SqlitePasswordResetStore extends SqliteOneTimeTokenStore {
	constructor(db: SqliteOneTimeTokenDatabase) {
		super(db, PASSWORD_RESET_TABLES)
	}
}
