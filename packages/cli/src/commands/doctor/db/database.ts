import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { KoraError } from '@korajs/core'

/** SQL dialect of a database `kora doctor --db` inspects. */
export type DoctorDialect = 'postgres' | 'sqlite'

/** One result row, as the driver returns it. */
export type DoctorRow = Record<string, unknown>

/**
 * A read-only view of a Kora server database. Every query runs inside one read-only
 * transaction (Postgres: `REPEATABLE READ READ ONLY`, so every check sees the same
 * snapshot; SQLite: a read-only connection with `query_only`), so the doctor can never
 * write, take a write lock or run DDL.
 */
export interface DoctorDatabase {
	readonly dialect: DoctorDialect
	/** The database location without credentials, safe to print. */
	readonly displayName: string
	/**
	 * Run a read query. Parameters are written `?` in the SQL text (converted to `$n` for
	 * Postgres), so one query text serves both dialects where the SQL agrees.
	 */
	all(sql: string, params?: readonly unknown[]): Promise<DoctorRow[]>
}

/** The database URL could not be used (unknown scheme, missing file, missing driver). */
export class DoctorDatabaseError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'DOCTOR_DATABASE_ERROR', context)
		this.name = 'DoctorDatabaseError'
	}
}

/** Where a `--db` value points. */
export interface DoctorDatabaseTarget {
	dialect: DoctorDialect
	/** Postgres connection string, or the SQLite file path (absolute). */
	location: string
	/** Printable form: no user, no password, no query string. */
	displayName: string
	/** Secrets the URL holds (the password), to scrub from driver error messages. */
	secrets: string[]
}

/**
 * Resolve a `--db` value: a `postgres://` / `postgresql://` URL, a `sqlite:` / `file:`
 * URL, a SQLite file path, or `env:NAME` to read any of these from an environment
 * variable (so the URL, and its password, never appear in a CI log or process list).
 *
 * @param value - The `--db` argument
 * @param cwd - Directory relative SQLite paths resolve against
 * @param env - Environment (tests)
 * @throws {DoctorDatabaseError} When the value is empty or names an unset variable
 */
export function parseDoctorDatabaseUrl(
	value: string,
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): DoctorDatabaseTarget {
	let raw = value.trim()
	if (raw.startsWith('env:')) {
		const name = raw.slice(4)
		const fromEnv = env[name]
		if (!fromEnv) {
			throw new DoctorDatabaseError(
				`--db env:${name}: the environment variable ${name} is not set.`,
				{ variable: name },
			)
		}
		raw = fromEnv.trim()
	}
	if (raw.length === 0) {
		throw new DoctorDatabaseError('--db needs a database URL or a SQLite file path.')
	}
	if (/^postgres(ql)?:\/\//i.test(raw)) {
		let display = 'postgres://(unparseable URL)'
		const secrets: string[] = []
		try {
			const url = new URL(raw)
			if (url.password) {
				secrets.push(url.password, decodeURIComponent(url.password))
			}
			// Host and database only: neither the user nor the password is printed.
			display = `${url.protocol}//${url.host}${url.pathname}`
		} catch {
			// The driver reports a malformed URL itself; never echo it.
		}
		return { dialect: 'postgres', location: raw, displayName: display, secrets }
	}
	let path = raw
	if (/^sqlite:/i.test(path)) path = path.replace(/^sqlite:(\/\/)?/i, '')
	else if (/^file:/i.test(path)) {
		try {
			path = decodeURIComponent(new URL(path).pathname)
		} catch {
			path = path.replace(/^file:(\/\/)?/i, '')
		}
	} else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
		throw new DoctorDatabaseError(
			`--db: unsupported database URL scheme "${path.split(':')[0]}". Use a postgres:// URL or a SQLite file path.`,
		)
	}
	const absolute = resolve(cwd, path)
	return { dialect: 'sqlite', location: absolute, displayName: absolute, secrets: [] }
}

/** Remove every secret of `target` from a message (driver errors can echo parts of a URL). */
export function scrubSecrets(
	message: string,
	target: Pick<DoctorDatabaseTarget, 'secrets'>,
): string {
	let out = message
	for (const secret of target.secrets) {
		if (secret.length > 0) out = out.split(secret).join('***')
	}
	// A full connection string with credentials, whatever produced it.
	return out.replace(/(postgres(?:ql)?:\/\/[^:/@\s]*):[^@\s]*@/gi, '$1:***@')
}

interface PostgresTransaction {
	unsafe(query: string, params?: unknown[]): Promise<unknown>
}

interface PostgresClient {
	begin<T>(options: string, fn: (tx: PostgresTransaction) => Promise<T>): Promise<T>
	end(options?: { timeout?: number }): Promise<void>
}

type PostgresFactory = (url: string, options: Record<string, unknown>) => PostgresClient

interface SqliteStatement {
	readonly reader: boolean
	all(...params: unknown[]): DoctorRow[]
	run(...params: unknown[]): unknown
}

interface SqliteConnection {
	prepare(sql: string): SqliteStatement
	exec(sql: string): void
	pragma(sql: string): unknown
	close(): void
}

type SqliteFactory = new (
	path: string,
	options: { readonly: boolean; fileMustExist: boolean },
) => SqliteConnection

/** Load a driver from the app (its dependencies), else from the CLI's own install. */
function loadDriver(name: string, projectRoot: string): unknown {
	const errors: string[] = []
	for (const base of [`${projectRoot}/package.json`, import.meta.url]) {
		try {
			return createRequire(base)(name)
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error))
		}
	}
	throw new DoctorDatabaseError(
		`kora doctor --db needs the "${name}" package to read this database. Install it in the app (pnpm add -D ${name}).`,
		{ package: name },
	)
}

/** Convert `?` placeholders to Postgres `$n` (the doctor's SQL never has `?` in literals). */
function toPostgresPlaceholders(sql: string): string {
	let n = 0
	return sql.replace(/\?/g, () => `$${++n}`)
}

/**
 * Open the database read-only, run `work` against it, and close it, whatever happens.
 * Postgres: one connection, one `REPEATABLE READ READ ONLY` transaction that is rolled
 * back at the end. SQLite: `readonly` + `fileMustExist` + `PRAGMA query_only`, inside one
 * read transaction (a consistent snapshot even while the server writes).
 *
 * @param target - From {@link parseDoctorDatabaseUrl}
 * @param projectRoot - The app, whose dependencies provide the driver
 * @param work - The checks
 * @throws {DoctorDatabaseError} When the database cannot be opened; the message never
 *   holds the URL's password
 */
export async function withDoctorDatabase<T>(
	target: DoctorDatabaseTarget,
	projectRoot: string,
	work: (db: DoctorDatabase) => Promise<T>,
): Promise<T> {
	if (target.dialect === 'postgres') {
		const loaded = loadDriver('postgres', projectRoot) as
			| PostgresFactory
			| { default: PostgresFactory }
		const factory = typeof loaded === 'function' ? loaded : loaded.default
		const client = factory(target.location, {
			max: 1,
			onnotice: () => {},
			connect_timeout: 15,
			// A preflight never holds a production connection open waiting.
			idle_timeout: 5,
			connection: { application_name: 'kora-doctor' },
		})
		const rollback = new Error('kora-doctor-rollback')
		let result: { value: T } | null = null
		try {
			await client.begin('isolation level repeatable read read only', async (tx) => {
				// Defense in depth: the transaction is already READ ONLY.
				await tx.unsafe('SET LOCAL default_transaction_read_only = on')
				// Never wait on a lock behind the server's own startup migration.
				await tx.unsafe("SET LOCAL lock_timeout = '10s'")
				const db: DoctorDatabase = {
					dialect: 'postgres',
					displayName: target.displayName,
					async all(sql, params = []) {
						return (await tx.unsafe(toPostgresPlaceholders(sql), [...params])) as DoctorRow[]
					},
				}
				result = { value: await work(db) }
				// Leave nothing behind: roll the read-only transaction back.
				throw rollback
			})
		} catch (error) {
			if (error !== rollback) {
				throw new DoctorDatabaseError(
					scrubSecrets(
						`Could not read ${target.displayName}: ${error instanceof Error ? error.message : String(error)}`,
						target,
					),
				)
			}
		} finally {
			await client.end({ timeout: 5 })
		}
		if (result === null) {
			throw new DoctorDatabaseError(`Could not read ${target.displayName}.`)
		}
		return (result as { value: T }).value
	}

	const Database = loadDriver('better-sqlite3', projectRoot) as SqliteFactory
	let connection: SqliteConnection
	try {
		connection = new Database(target.location, { readonly: true, fileMustExist: true })
	} catch (error) {
		throw new DoctorDatabaseError(
			`Could not open the SQLite database ${target.displayName} read-only: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	try {
		connection.pragma('query_only = ON')
		connection.exec('BEGIN')
		const db: DoctorDatabase = {
			dialect: 'sqlite',
			displayName: target.displayName,
			async all(sql, params = []) {
				const statement = connection.prepare(sql)
				// A statement that returns no rows goes through run(), so a write attempt
				// meets the read-only connection (SQLITE_READONLY) rather than a driver error.
				if (!statement.reader) {
					statement.run(...params)
					return []
				}
				return statement.all(...params)
			},
		}
		return await work(db)
	} finally {
		try {
			connection.exec('ROLLBACK')
		} catch {
			// no transaction open (BEGIN failed): nothing to end
		}
		connection.close()
	}
}
