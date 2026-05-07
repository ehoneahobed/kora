import { randomUUID } from 'node:crypto'
import type { UserStore, AuthUser, StoredUser, AuthDevice } from './user-store'
import { DuplicateEmailError } from './user-store'

/**
 * Row shape returned by better-sqlite3 for the auth_users table.
 */
interface UserRow {
	id: string
	email: string
	name: string
	email_verified: number
	created_at: number
	password_hash: string
	salt: string
}

/**
 * Row shape returned by better-sqlite3 for the auth_devices table.
 */
interface DeviceRow {
	id: string
	user_id: string
	public_key: string
	name: string
	revoked: number
	created_at: number
	last_seen_at: number
}

/**
 * Minimal better-sqlite3 subset to avoid a hard dependency on the package.
 * The real Database instance satisfies this at runtime.
 */
interface SqliteDatabase {
	pragma(source: string): unknown
	exec(source: string): void
	prepare(source: string): {
		run(...params: unknown[]): unknown
		get(...params: unknown[]): unknown
		all(...params: unknown[]): unknown[]
	}
	transaction<T>(fn: () => T): () => T
}

/**
 * SQLite-backed user and device store using better-sqlite3.
 *
 * Provides persistent user storage suitable for single-server deployments,
 * Electron apps, and development environments. Uses WAL mode for concurrent
 * read/write performance.
 *
 * This implementation uses dynamic imports for better-sqlite3 so projects
 * that do not use SQLite server-side do not need to install it.
 *
 * @example
 * ```typescript
 * import { createSqliteUserStore } from '@korajs/auth/server'
 *
 * const userStore = await createSqliteUserStore({ filename: './auth.db' })
 * const routes = new BuiltInAuthRoutes({ userStore, tokenManager })
 * ```
 */
export class SqliteUserStore implements UserStore {
	private readonly db: SqliteDatabase

	constructor(db: SqliteDatabase) {
		this.db = db
		this.db.pragma('journal_mode = WAL')
		this.ensureTables()
	}

	private ensureTables(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS auth_users (
				id TEXT PRIMARY KEY,
				email TEXT NOT NULL UNIQUE COLLATE NOCASE,
				name TEXT NOT NULL,
				email_verified INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				password_hash TEXT NOT NULL,
				salt TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS auth_devices (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				public_key TEXT NOT NULL,
				name TEXT NOT NULL,
				revoked INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				last_seen_at INTEGER NOT NULL,
				FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
			);

			CREATE INDEX IF NOT EXISTS idx_auth_devices_user_id ON auth_devices(user_id);
		`)
	}

	async createUser(params: {
		email: string
		passwordHash: string
		salt: string
		name: string
	}): Promise<AuthUser> {
		const normalizedEmail = params.email.toLowerCase()
		const now = Date.now()
		const id = randomUUID()

		try {
			this.db.prepare(`
				INSERT INTO auth_users (id, email, name, email_verified, created_at, password_hash, salt)
				VALUES (?, ?, ?, 0, ?, ?, ?)
			`).run(id, normalizedEmail, params.name, now, params.passwordHash, params.salt)
		} catch (err: unknown) {
			if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
				throw new DuplicateEmailError()
			}
			throw err
		}

		return { id, email: normalizedEmail, name: params.name, emailVerified: false, createdAt: now }
	}

	async findByEmail(email: string): Promise<StoredUser | null> {
		const row = this.db.prepare(
			'SELECT * FROM auth_users WHERE email = ?',
		).get(email.toLowerCase()) as UserRow | undefined

		return row ? rowToStoredUser(row) : null
	}

	async findById(id: string): Promise<StoredUser | null> {
		const row = this.db.prepare(
			'SELECT * FROM auth_users WHERE id = ?',
		).get(id) as UserRow | undefined

		return row ? rowToStoredUser(row) : null
	}

	async registerDevice(params: {
		id: string
		userId: string
		publicKey: string
		name: string
	}): Promise<AuthDevice> {
		const existing = this.db.prepare(
			'SELECT * FROM auth_devices WHERE id = ?',
		).get(params.id) as DeviceRow | undefined

		if (existing && !existing.revoked) {
			return rowToDevice(existing)
		}

		const now = Date.now()

		if (existing) {
			// Re-activate previously revoked device
			this.db.prepare(`
				UPDATE auth_devices SET revoked = 0, public_key = ?, name = ?, last_seen_at = ?
				WHERE id = ?
			`).run(params.publicKey, params.name, now, params.id)
		} else {
			this.db.prepare(`
				INSERT INTO auth_devices (id, user_id, public_key, name, revoked, created_at, last_seen_at)
				VALUES (?, ?, ?, ?, 0, ?, ?)
			`).run(params.id, params.userId, params.publicKey, params.name, now, now)
		}

		return {
			id: params.id,
			userId: params.userId,
			publicKey: params.publicKey,
			name: params.name,
			revoked: false,
			createdAt: existing ? existing.created_at : now,
			lastSeenAt: now,
		}
	}

	async findDevice(deviceId: string): Promise<AuthDevice | null> {
		const row = this.db.prepare(
			'SELECT * FROM auth_devices WHERE id = ?',
		).get(deviceId) as DeviceRow | undefined

		return row ? rowToDevice(row) : null
	}

	async listDevices(userId: string): Promise<AuthDevice[]> {
		const rows = this.db.prepare(
			'SELECT * FROM auth_devices WHERE user_id = ?',
		).all(userId) as DeviceRow[]

		return rows.map(rowToDevice)
	}

	async revokeDevice(deviceId: string): Promise<void> {
		this.db.prepare('UPDATE auth_devices SET revoked = 1 WHERE id = ?').run(deviceId)
	}

	async setEmailVerified(userId: string, verified: boolean): Promise<void> {
		this.db.prepare(
			'UPDATE auth_users SET email_verified = ? WHERE id = ?',
		).run(verified ? 1 : 0, userId)
	}

	async updatePassword(userId: string, passwordHash: string, salt: string): Promise<void> {
		this.db.prepare(
			'UPDATE auth_users SET password_hash = ?, salt = ? WHERE id = ?',
		).run(passwordHash, salt, userId)
	}

	async listAll(): Promise<StoredUser[]> {
		const rows = this.db.prepare('SELECT * FROM auth_users').all() as UserRow[]
		return rows.map(rowToStoredUser)
	}

	async update(user: StoredUser): Promise<void> {
		this.db.prepare(`
			UPDATE auth_users
			SET email = ?, name = ?, email_verified = ?, password_hash = ?, salt = ?
			WHERE id = ?
		`).run(user.email, user.name, user.emailVerified ? 1 : 0, user.passwordHash, user.salt, user.id)
	}

	async delete(userId: string): Promise<void> {
		const deleteInTransaction = this.db.transaction(() => {
			this.db.prepare('DELETE FROM auth_devices WHERE user_id = ?').run(userId)
			this.db.prepare('DELETE FROM auth_users WHERE id = ?').run(userId)
		})
		deleteInTransaction()
	}

	async touchDevice(deviceId: string): Promise<void> {
		this.db.prepare(
			'UPDATE auth_devices SET last_seen_at = ? WHERE id = ?',
		).run(Date.now(), deviceId)
	}
}

/**
 * Creates a SqliteUserStore from a file path.
 *
 * Uses runtime dynamic imports so projects that do not use SQLite server-side
 * do not need to install `better-sqlite3`.
 *
 * @param options.filename - Path to the SQLite database file, or `:memory:` for in-memory
 */
export async function createSqliteUserStore(options: {
	filename: string
}): Promise<SqliteUserStore> {
	const Database = await loadBetterSqlite3()
	const db = new Database(options.filename)
	return new SqliteUserStore(db as unknown as SqliteDatabase)
}

async function loadBetterSqlite3(): Promise<new (filename: string) => unknown> {
	try {
		// Use createRequire for CJS compatibility with better-sqlite3
		const { createRequire } = await import('node:module')
		const require = createRequire(import.meta.url)
		return require('better-sqlite3') as new (filename: string) => unknown
	} catch {
		throw new Error(
			'SQLite backend requires the "better-sqlite3" package. Install it in your project dependencies.',
		)
	}
}

function rowToStoredUser(row: UserRow): StoredUser {
	return {
		id: row.id,
		email: row.email,
		name: row.name,
		emailVerified: Boolean(row.email_verified),
		createdAt: row.created_at,
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
		createdAt: row.created_at,
		lastSeenAt: row.last_seen_at,
	}
}
