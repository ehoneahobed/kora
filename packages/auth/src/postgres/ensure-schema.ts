/**
 * Minimal postgres-js tagged-template client used for schema setup. `begin` is
 * optional so the narrowest store clients (a bare tagged template) still work.
 */
export interface PostgresDdlClient {
	(template: TemplateStringsArray, ...args: unknown[]): Promise<Record<string, unknown>[]>
	begin?: <T>(fn: (sql: PostgresDdlClient) => Promise<T>) => Promise<T>
}

/**
 * Advisory-lock key serializing every Kora auth schema setup on one database
 * ("Kora" in ASCII).
 */
export const AUTH_SCHEMA_LOCK_KEY = 0x4b6f7261

/**
 * SQLSTATEs a concurrent `CREATE ... IF NOT EXISTS` can still raise when two
 * sessions create the same object at once: the check and the catalog insert are not
 * atomic, so the loser fails on the catalog's unique index ("type ... already
 * exists", 23505) or as a duplicate table / object (42P07 / 42710).
 */
const CONCURRENT_DDL_CODES = new Set(['23505', '42P07', '42710'])

const MAX_ATTEMPTS = 3

/**
 * Create a store's tables safely when several server instances start against an
 * empty database at the same time.
 *
 * With a transaction-capable client the DDL runs inside one transaction holding
 * {@link AUTH_SCHEMA_LOCK_KEY} as a transaction-scoped advisory lock, so concurrent
 * first starts are serialized and the later ones find every object already there.
 * A client without `begin` (or a database that still reports a creation race) is
 * retried: the statements are idempotent (`IF NOT EXISTS`), so a retry after a lost
 * race succeeds.
 *
 * @param sql - The postgres-js client
 * @param ddl - Idempotent DDL statements, run with the client (or transaction) given
 */
export async function ensurePostgresSchema(
	sql: PostgresDdlClient,
	ddl: (client: PostgresDdlClient) => Promise<void>,
): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			if (typeof sql.begin === 'function') {
				await sql.begin(async (tx) => {
					await tx`SELECT pg_advisory_xact_lock(${AUTH_SCHEMA_LOCK_KEY}::bigint)`
					await ddl(tx)
				})
			} else {
				await ddl(sql)
			}
			return
		} catch (error) {
			if (attempt >= MAX_ATTEMPTS || !isConcurrentDdlError(error)) throw error
		}
	}
}

function isConcurrentDdlError(error: unknown): boolean {
	if (error === null || typeof error !== 'object') return false
	const code = (error as { code?: unknown }).code
	return typeof code === 'string' && CONCURRENT_DDL_CODES.has(code)
}
