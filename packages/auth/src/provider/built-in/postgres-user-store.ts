import { randomUUID } from 'node:crypto'
import type { UserStore, AuthUser, StoredUser, AuthDevice } from './user-store'
import { DuplicateEmailError } from './user-store'

/**
 * Minimal typed subset of a postgres-js SQL tag for our queries.
 * Avoids a hard dependency on the postgres package.
 * Uses Record<string, unknown>[] for result type to match postgres-js return shape.
 */
interface PostgresClient {
	begin<T>(fn: (sql: PostgresClient) => Promise<T>): Promise<T>
	(
		template: TemplateStringsArray,
		...args: unknown[]
	): Promise<Record<string, unknown>[]>
}

/**
 * PostgreSQL-backed user and device store using postgres-js.
 *
 * Provides persistent user storage suitable for production multi-server
 * deployments. Uses parameterized queries for SQL injection safety and
 * transactions for atomic operations.
 *
 * This implementation uses dynamic imports for postgres so projects
 * that do not use PostgreSQL do not need to install it.
 *
 * @example
 * ```typescript
 * import { createPostgresUserStore } from '@korajs/auth/server'
 *
 * const userStore = await createPostgresUserStore({
 *   connectionString: 'postgres://user:pass@localhost:5432/mydb',
 * })
 * const routes = new BuiltInAuthRoutes({ userStore, tokenManager })
 * ```
 */
export class PostgresUserStore implements UserStore {
	private readonly sql: PostgresClient
	private readonly ready: Promise<void>

	constructor(sql: PostgresClient) {
		this.sql = sql
		this.ready = this.ensureTables()
	}

	private async ensureTables(): Promise<void> {
		await this.sql`
			CREATE TABLE IF NOT EXISTS auth_users (
				id TEXT PRIMARY KEY,
				email TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				email_verified BOOLEAN NOT NULL DEFAULT FALSE,
				created_at BIGINT NOT NULL,
				password_hash TEXT NOT NULL,
				salt TEXT NOT NULL
			)
		`

		await this.sql`
			CREATE TABLE IF NOT EXISTS auth_devices (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
				public_key TEXT NOT NULL,
				name TEXT NOT NULL,
				revoked BOOLEAN NOT NULL DEFAULT FALSE,
				created_at BIGINT NOT NULL,
				last_seen_at BIGINT NOT NULL
			)
		`

		await this.sql`
			CREATE INDEX IF NOT EXISTS idx_auth_devices_user_id ON auth_devices(user_id)
		`

		// Case-insensitive unique index on email for consistent lookups
		await this.sql`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_email_lower ON auth_users(LOWER(email))
		`
	}

	async createUser(params: {
		email: string
		passwordHash: string
		salt: string
		name: string
	}): Promise<AuthUser> {
		await this.ready
		const normalizedEmail = params.email.toLowerCase()
		const now = Date.now()
		const id = randomUUID()

		try {
			await this.sql`
				INSERT INTO auth_users (id, email, name, email_verified, created_at, password_hash, salt)
				VALUES (${id}, ${normalizedEmail}, ${params.name}, FALSE, ${now}, ${params.passwordHash}, ${params.salt})
			`
		} catch (err: unknown) {
			if (err instanceof Error && (
				err.message.includes('unique constraint') ||
				err.message.includes('duplicate key')
			)) {
				throw new DuplicateEmailError()
			}
			throw err
		}

		return { id, email: normalizedEmail, name: params.name, emailVerified: false, createdAt: now }
	}

	async findByEmail(email: string): Promise<StoredUser | null> {
		await this.ready
		const rows = await this.sql`
			SELECT * FROM auth_users WHERE LOWER(email) = ${email.toLowerCase()}
		`
		return rows.length > 0 ? rowToStoredUser(rows[0] as unknown as UserRow) : null
	}

	async findById(id: string): Promise<StoredUser | null> {
		await this.ready
		const rows = await this.sql`
			SELECT * FROM auth_users WHERE id = ${id}
		`
		return rows.length > 0 ? rowToStoredUser(rows[0] as unknown as UserRow) : null
	}

	async registerDevice(params: {
		id: string
		userId: string
		publicKey: string
		name: string
	}): Promise<AuthDevice> {
		await this.ready
		const existingRows = await this.sql`
			SELECT * FROM auth_devices WHERE id = ${params.id}
		` as unknown as DeviceRow[]

		if (existingRows.length > 0 && !existingRows[0]!.revoked) {
			return rowToDevice(existingRows[0]!)
		}

		const now = Date.now()

		if (existingRows.length > 0) {
			// Re-activate previously revoked device
			await this.sql`
				UPDATE auth_devices SET revoked = FALSE, public_key = ${params.publicKey}, name = ${params.name}, last_seen_at = ${now}
				WHERE id = ${params.id}
			`
		} else {
			await this.sql`
				INSERT INTO auth_devices (id, user_id, public_key, name, revoked, created_at, last_seen_at)
				VALUES (${params.id}, ${params.userId}, ${params.publicKey}, ${params.name}, FALSE, ${now}, ${now})
			`
		}

		return {
			id: params.id,
			userId: params.userId,
			publicKey: params.publicKey,
			name: params.name,
			revoked: false,
			createdAt: existingRows.length > 0 ? Number(existingRows[0]!.created_at) : now,
			lastSeenAt: now,
		}
	}

	async findDevice(deviceId: string): Promise<AuthDevice | null> {
		await this.ready
		const rows = await this.sql`
			SELECT * FROM auth_devices WHERE id = ${deviceId}
		`
		return rows.length > 0 ? rowToDevice(rows[0] as unknown as DeviceRow) : null
	}

	async listDevices(userId: string): Promise<AuthDevice[]> {
		await this.ready
		const rows = await this.sql`
			SELECT * FROM auth_devices WHERE user_id = ${userId}
		` as unknown as DeviceRow[]
		return rows.map(rowToDevice)
	}

	async revokeDevice(deviceId: string): Promise<void> {
		await this.ready
		await this.sql`UPDATE auth_devices SET revoked = TRUE WHERE id = ${deviceId}`
	}

	async setEmailVerified(userId: string, verified: boolean): Promise<void> {
		await this.ready
		await this.sql`UPDATE auth_users SET email_verified = ${verified} WHERE id = ${userId}`
	}

	async updatePassword(userId: string, passwordHash: string, salt: string): Promise<void> {
		await this.ready
		await this.sql`
			UPDATE auth_users SET password_hash = ${passwordHash}, salt = ${salt}
			WHERE id = ${userId}
		`
	}

	async listAll(): Promise<StoredUser[]> {
		await this.ready
		const rows = await this.sql`SELECT * FROM auth_users` as unknown as UserRow[]
		return rows.map(rowToStoredUser)
	}

	async update(user: StoredUser): Promise<void> {
		await this.ready
		await this.sql`
			UPDATE auth_users
			SET email = ${user.email}, name = ${user.name}, email_verified = ${user.emailVerified},
				password_hash = ${user.passwordHash}, salt = ${user.salt}
			WHERE id = ${user.id}
		`
	}

	async delete(userId: string): Promise<void> {
		await this.ready
		// Devices cascade-delete via FK constraint, but be explicit
		await this.sql.begin(async (tx) => {
			await tx`DELETE FROM auth_devices WHERE user_id = ${userId}`
			await tx`DELETE FROM auth_users WHERE id = ${userId}`
		})
	}

	async touchDevice(deviceId: string): Promise<void> {
		await this.ready
		const now = Date.now()
		await this.sql`UPDATE auth_devices SET last_seen_at = ${now} WHERE id = ${deviceId}`
	}
}

/**
 * Creates a PostgresUserStore from a connection string.
 *
 * Uses runtime dynamic imports so projects that do not use PostgreSQL
 * do not need to install `postgres`.
 *
 * @param options.connectionString - PostgreSQL connection URL (e.g., `postgres://user:pass@host:5432/db`)
 */
export async function createPostgresUserStore(options: {
	connectionString: string
}): Promise<PostgresUserStore> {
	const postgresClient = await loadPostgresDeps()
	const sql = postgresClient(options.connectionString) as unknown as PostgresClient
	return new PostgresUserStore(sql)
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
			'PostgreSQL backend requires the "postgres" package. Install it in your project dependencies.',
		)
	}
}

/**
 * Row shapes from postgres-js queries. Field names match SQL column names.
 */
interface UserRow {
	id: string
	email: string
	name: string
	email_verified: boolean
	created_at: string | number
	password_hash: string
	salt: string
}

interface DeviceRow {
	id: string
	user_id: string
	public_key: string
	name: string
	revoked: boolean
	created_at: string | number
	last_seen_at: string | number
}

function rowToStoredUser(row: UserRow): StoredUser {
	return {
		id: row.id,
		email: row.email,
		name: row.name,
		emailVerified: Boolean(row.email_verified),
		createdAt: Number(row.created_at),
		passwordHash: row.password_hash,
		salt: row.salt,
	}
}

function rowToDevice(row: DeviceRow): AuthDevice {
	return {
		id: row.id,
		userId: row.user_id,
		publicKey: row.public_key,
		name: row.name,
		revoked: Boolean(row.revoked),
		createdAt: Number(row.created_at),
		lastSeenAt: Number(row.last_seen_at),
	}
}
