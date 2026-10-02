import { ensurePostgresSchema } from '../postgres/ensure-schema'
import type { ConsumeResult, TokenRevocationStore } from './token-manager'

/**
 * Minimal postgres-js tagged-template client.
 */
export type PostgresRevocationClient = (
	template: TemplateStringsArray,
	...args: unknown[]
) => Promise<Record<string, unknown>[]>

/**
 * PostgreSQL-backed {@link TokenRevocationStore} (postgres-js).
 *
 * Shared by every server instance using the database. `consume` is one
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING`, so exactly one concurrent
 * caller, on any instance, consumes a refresh token (AUTH-6).
 *
 * @example
 * ```typescript
 * const userStore = await createPostgresUserStore({ connectionString })
 * const revocationStore = userStore.getTokenRevocationStore()
 * ```
 */
export class PostgresTokenRevocationStore implements TokenRevocationStore {
	private readonly ready: Promise<void>

	constructor(private readonly sql: PostgresRevocationClient) {
		this.ready = this.ensureTables()
	}

	private async ensureTables(): Promise<void> {
		// Concurrency-safe on an empty database shared by several instances.
		await ensurePostgresSchema(this.sql, async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS auth_token_revocations (
					jti TEXT PRIMARY KEY,
					expires_at BIGINT NOT NULL
				)
			`
			await sql`
				CREATE TABLE IF NOT EXISTS auth_token_consumptions (
					jti TEXT PRIMARY KEY,
					consumed_at BIGINT NOT NULL,
					expires_at BIGINT NOT NULL
				)
			`
			await sql`
				CREATE TABLE IF NOT EXISTS auth_token_cutoffs (
					kind TEXT NOT NULL,
					subject_id TEXT NOT NULL,
					revoked_before BIGINT NOT NULL,
					PRIMARY KEY (kind, subject_id)
				)
			`
		})
	}

	async isRevoked(jti: string): Promise<boolean> {
		await this.ready
		const rows = await this.sql`SELECT 1 FROM auth_token_revocations WHERE jti = ${jti}`
		return rows.length > 0
	}

	async revoke(jti: string, expiresAt: number): Promise<void> {
		await this.ready
		await this.sql`
			INSERT INTO auth_token_revocations (jti, expires_at) VALUES (${jti}, ${expiresAt})
			ON CONFLICT (jti) DO NOTHING
		`
	}

	async consume(jti: string, expiresAt: number): Promise<ConsumeResult> {
		await this.ready
		const now = Date.now()
		const inserted = await this.sql`
			INSERT INTO auth_token_consumptions (jti, consumed_at, expires_at)
			VALUES (${jti}, ${now}, ${expiresAt})
			ON CONFLICT (jti) DO NOTHING
			RETURNING consumed_at
		`
		if (inserted.length === 1) return { firstUse: true, consumedAt: now }
		const rows = await this.sql`SELECT consumed_at FROM auth_token_consumptions WHERE jti = ${jti}`
		const consumedAt = rows[0]?.consumed_at
		return { firstUse: false, consumedAt: consumedAt === undefined ? now : Number(consumedAt) }
	}

	async isConsumed(jti: string): Promise<boolean> {
		await this.ready
		const rows = await this.sql`SELECT 1 FROM auth_token_consumptions WHERE jti = ${jti}`
		return rows.length > 0
	}

	async revokeAllForDevice(deviceId: string, before: number = Date.now()): Promise<void> {
		await this.setCutoff('device', deviceId, before)
	}

	async getDeviceRevokedBefore(deviceId: string): Promise<number | null> {
		return this.getCutoff('device', deviceId)
	}

	async revokeAllForUser(userId: string, before: number = Date.now()): Promise<void> {
		await this.setCutoff('user', userId, before)
	}

	async getUserRevokedBefore(userId: string): Promise<number | null> {
		return this.getCutoff('user', userId)
	}

	/** Delete revocations and consumptions whose tokens have expired. */
	async cleanup(): Promise<void> {
		await this.ready
		const nowSeconds = Math.floor(Date.now() / 1000)
		await this.sql`DELETE FROM auth_token_revocations WHERE expires_at < ${nowSeconds}`
		await this.sql`DELETE FROM auth_token_consumptions WHERE expires_at < ${nowSeconds}`
	}

	private async setCutoff(
		kind: 'device' | 'user',
		subjectId: string,
		before: number,
	): Promise<void> {
		await this.ready
		await this.sql`
			INSERT INTO auth_token_cutoffs (kind, subject_id, revoked_before)
			VALUES (${kind}, ${subjectId}, ${before})
			ON CONFLICT (kind, subject_id)
			DO UPDATE SET revoked_before = GREATEST(auth_token_cutoffs.revoked_before, EXCLUDED.revoked_before)
		`
	}

	private async getCutoff(kind: 'device' | 'user', subjectId: string): Promise<number | null> {
		await this.ready
		const rows = await this.sql`
			SELECT revoked_before FROM auth_token_cutoffs WHERE kind = ${kind} AND subject_id = ${subjectId}
		`
		const value = rows[0]?.revoked_before
		return value === undefined ? null : Number(value)
	}
}
