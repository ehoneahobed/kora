import type { ConsumeResult, TokenRevocationStore } from './token-manager'

/**
 * Minimal better-sqlite3 subset to avoid a hard dependency on the package.
 */
export interface SqliteRevocationDatabase {
	exec(source: string): void
	prepare(source: string): {
		run(...params: unknown[]): { changes: number }
		get(...params: unknown[]): unknown
	}
}

/**
 * SQLite-backed {@link TokenRevocationStore} (better-sqlite3).
 *
 * Revocations survive restarts and are shared by every process using the same
 * database file. `consume` is a single `INSERT ... ON CONFLICT DO NOTHING`, so it
 * is atomic: better-sqlite3 executes statements synchronously under SQLite's
 * write lock.
 *
 * @example
 * ```typescript
 * const userStore = await createSqliteUserStore({ filename: './auth.db' })
 * const revocationStore = userStore.getTokenRevocationStore()
 * ```
 */
export class SqliteTokenRevocationStore implements TokenRevocationStore {
	constructor(private readonly db: SqliteRevocationDatabase) {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS auth_token_revocations (
				jti TEXT PRIMARY KEY,
				expires_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS auth_token_consumptions (
				jti TEXT PRIMARY KEY,
				consumed_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS auth_token_cutoffs (
				kind TEXT NOT NULL,
				subject_id TEXT NOT NULL,
				revoked_before INTEGER NOT NULL,
				PRIMARY KEY (kind, subject_id)
			);
		`)
	}

	async isRevoked(jti: string): Promise<boolean> {
		return (
			this.db.prepare('SELECT 1 FROM auth_token_revocations WHERE jti = ?').get(jti) !== undefined
		)
	}

	async revoke(jti: string, expiresAt: number): Promise<void> {
		this.db
			.prepare(
				'INSERT INTO auth_token_revocations (jti, expires_at) VALUES (?, ?) ON CONFLICT(jti) DO NOTHING',
			)
			.run(jti, expiresAt)
	}

	async consume(jti: string, expiresAt: number): Promise<ConsumeResult> {
		const now = Date.now()
		const inserted = this.db
			.prepare(
				'INSERT INTO auth_token_consumptions (jti, consumed_at, expires_at) VALUES (?, ?, ?) ON CONFLICT(jti) DO NOTHING',
			)
			.run(jti, now, expiresAt)
		if (inserted.changes === 1) return { firstUse: true, consumedAt: now }
		const row = this.db
			.prepare('SELECT consumed_at FROM auth_token_consumptions WHERE jti = ?')
			.get(jti) as { consumed_at: number } | undefined
		return { firstUse: false, consumedAt: row ? Number(row.consumed_at) : now }
	}

	async isConsumed(jti: string): Promise<boolean> {
		return (
			this.db.prepare('SELECT 1 FROM auth_token_consumptions WHERE jti = ?').get(jti) !== undefined
		)
	}

	async revokeAllForDevice(deviceId: string, before: number = Date.now()): Promise<void> {
		this.setCutoff('device', deviceId, before)
	}

	async getDeviceRevokedBefore(deviceId: string): Promise<number | null> {
		return this.getCutoff('device', deviceId)
	}

	async revokeAllForUser(userId: string, before: number = Date.now()): Promise<void> {
		this.setCutoff('user', userId, before)
	}

	async getUserRevokedBefore(userId: string): Promise<number | null> {
		return this.getCutoff('user', userId)
	}

	/** Delete revocations and consumptions whose tokens have expired. */
	async cleanup(): Promise<void> {
		const nowSeconds = Math.floor(Date.now() / 1000)
		this.db.prepare('DELETE FROM auth_token_revocations WHERE expires_at < ?').run(nowSeconds)
		this.db.prepare('DELETE FROM auth_token_consumptions WHERE expires_at < ?').run(nowSeconds)
	}

	private setCutoff(kind: 'device' | 'user', subjectId: string, before: number): void {
		this.db
			.prepare(
				`INSERT INTO auth_token_cutoffs (kind, subject_id, revoked_before) VALUES (?, ?, ?)
				 ON CONFLICT(kind, subject_id) DO UPDATE SET revoked_before = MAX(revoked_before, excluded.revoked_before)`,
			)
			.run(kind, subjectId, before)
	}

	private getCutoff(kind: 'device' | 'user', subjectId: string): number | null {
		const row = this.db
			.prepare('SELECT revoked_before FROM auth_token_cutoffs WHERE kind = ? AND subject_id = ?')
			.get(kind, subjectId) as { revoked_before: number } | undefined
		return row ? Number(row.revoked_before) : null
	}
}
