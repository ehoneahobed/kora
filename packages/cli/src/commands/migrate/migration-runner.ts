import {
	expandRelaxValueDomainForPostgres,
	expandRelaxValueDomainForSqlite,
	parseRelaxValueDomainDirective,
} from './value-domain-directive'

export interface RunMigrationOptions {
	upStatements: string[]
	migrationId?: string
	fromVersion?: number
	toVersion?: number
	sqlitePath?: string
	postgresConnectionString?: string
	projectRoot?: string
	sqliteDriver?: {
		open(path: string): {
			exec(sql: string): void
			isMigrationApplied?(id: string): boolean
			/** Runs a SELECT/PRAGMA and returns its rows (needed by value-domain directives). */
			query?(sql: string): Array<Record<string, unknown>>
			close?(): void
		}
	}
	postgresClientFactory?: (connectionString: string) => {
		unsafe(query: string): Promise<unknown>
		end?(): Promise<void>
	}
}

export interface BackendApplyReport {
	backend: 'sqlite' | 'postgres'
	statementsApplied: number
	historyRecorded: boolean
	skipped: boolean
}

export interface RunMigrationReport {
	backends: BackendApplyReport[]
}

export class MigrationApplyError extends Error {
	constructor(
		message: string,
		public readonly backend: 'sqlite' | 'postgres',
		public readonly report: RunMigrationReport,
	) {
		super(message)
		this.name = 'MigrationApplyError'
	}
}

/**
 * Applies migration statements to configured backends.
 */
export async function runMigration(options: RunMigrationOptions): Promise<RunMigrationReport> {
	const report: RunMigrationReport = { backends: [] }
	const migrationId = options.migrationId ?? `migration-${Date.now()}`
	const fromVersion = options.fromVersion ?? 0
	const toVersion = options.toVersion ?? 0

	if (options.sqlitePath) {
		try {
			const sqliteReport = await runSqliteMigration(
				options.sqlitePath,
				options.upStatements,
				migrationId,
				fromVersion,
				toVersion,
				options.projectRoot,
				options.sqliteDriver,
			)
			report.backends.push(sqliteReport)
		} catch (error) {
			throw new MigrationApplyError((error as Error).message, 'sqlite', report)
		}
	}

	if (options.postgresConnectionString) {
		try {
			const postgresReport = await runPostgresMigration(
				options.postgresConnectionString,
				options.upStatements,
				migrationId,
				fromVersion,
				toVersion,
				options.postgresClientFactory,
			)
			report.backends.push(postgresReport)
		} catch (error) {
			throw new MigrationApplyError((error as Error).message, 'postgres', report)
		}
	}

	return report
}

async function runSqliteMigration(
	path: string,
	statements: string[],
	migrationId: string,
	fromVersion: number,
	toVersion: number,
	projectRoot?: string,
	driverOverride?: RunMigrationOptions['sqliteDriver'],
): Promise<BackendApplyReport> {
	const driver = driverOverride ?? (await loadSqliteDriver(projectRoot))
	const db = driver.open(path)
	let statementsApplied = 0

	// SQLite's table-rebuild procedure (generated rebuilds, relax-value-domain directives)
	// needs foreign key enforcement off, and the pragma is a no-op inside a transaction.
	const foreignKeysOn = Number(db.query?.('PRAGMA foreign_keys')[0]?.foreign_keys ?? 0) === 1
	if (foreignKeysOn) db.exec('PRAGMA foreign_keys = OFF')

	try {
		db.exec('BEGIN')
		db.exec(
			'CREATE TABLE IF NOT EXISTS _kora_migrations (id TEXT PRIMARY KEY NOT NULL, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL, applied_at INTEGER NOT NULL)',
		)
		const alreadyApplied =
			typeof db.isMigrationApplied === 'function' ? db.isMigrationApplied(migrationId) : false
		if (alreadyApplied) {
			db.exec('COMMIT')
			return {
				backend: 'sqlite',
				statementsApplied: 0,
				historyRecorded: true,
				skipped: true,
			}
		}
		for (const statement of statements) {
			const directive = parseRelaxValueDomainDirective(statement)
			if (directive) {
				const query = db.query?.bind(db)
				if (!query) {
					throw new Error(
						`Migration ${migrationId}: the SQLite driver cannot read the catalog needed to relax "${directive.table}".`,
					)
				}
				const expanded = await expandRelaxValueDomainForSqlite(directive, async (text) =>
					query(text),
				)
				for (const rebuild of expanded) db.exec(rebuild)
			} else {
				db.exec(statement)
			}
			statementsApplied++
		}
		// Table rebuilds run with foreign key enforcement off: refuse to commit one that left
		// a dangling reference.
		const violations = db.query?.('PRAGMA foreign_key_check') ?? []
		if (violations.length > 0) {
			throw new Error(
				`Migration ${migrationId} left ${violations.length} foreign key violation(s) (first: ${JSON.stringify(violations[0])}); nothing was applied.`,
			)
		}
		db.exec(
			`INSERT OR REPLACE INTO _kora_migrations (id, from_version, to_version, applied_at) VALUES (${sqlLiteral(migrationId)}, ${fromVersion}, ${toVersion}, ${Date.now()})`,
		)
		db.exec('COMMIT')

		return {
			backend: 'sqlite',
			statementsApplied,
			historyRecorded: true,
			skipped: false,
		}
	} catch (error) {
		try {
			db.exec('ROLLBACK')
		} catch {
			// best effort
		}
		throw error
	} finally {
		if (foreignKeysOn) {
			try {
				db.exec('PRAGMA foreign_keys = ON')
			} catch {
				// the connection is closed next; enforcement is per connection
			}
		}
		if (typeof db.close === 'function') {
			db.close()
		}
	}
}

async function loadSqliteDriver(projectRoot?: string): Promise<{
	open(path: string): {
		exec(sql: string): void
		isMigrationApplied(id: string): boolean
		query(sql: string): Array<Record<string, unknown>>
		close(): void
	}
}> {
	try {
		const { createRequire } = await import('node:module')
		const requireFrom = createRequire(projectRoot ? `${projectRoot}/package.json` : import.meta.url)
		const Database = requireFrom('better-sqlite3') as new (
			path: string,
		) => {
			exec(sql: string): void
			prepare(sql: string): {
				get(...params: unknown[]): { count?: number } | undefined
				all(...params: unknown[]): Array<Record<string, unknown>>
			}
			close(): void
		}

		return {
			open(path: string) {
				const db = new Database(path)
				return {
					exec(sql: string) {
						db.exec(sql)
					},
					isMigrationApplied(id: string) {
						const row = db
							.prepare('SELECT COUNT(*) AS count FROM _kora_migrations WHERE id = ?')
							.get(id)
						return (row?.count ?? 0) > 0
					},
					query(sql: string) {
						return db.prepare(sql).all()
					},
					close() {
						db.close()
					},
				}
			},
		}
	} catch {
		throw new Error(
			'SQLite migration apply requires the "better-sqlite3" package in the target project dependencies.',
		)
	}
}

async function runPostgresMigration(
	connectionString: string,
	statements: string[],
	migrationId: string,
	fromVersion: number,
	toVersion: number,
	clientFactoryOverride?: RunMigrationOptions['postgresClientFactory'],
): Promise<BackendApplyReport> {
	const sql =
		typeof clientFactoryOverride === 'function'
			? clientFactoryOverride(connectionString)
			: // One connection: BEGIN, the statements and COMMIT must share it (postgres.js
				// refuses a raw BEGIN on a pool, UNSAFE_TRANSACTION).
				(await loadPostgresModule()).default(connectionString, { max: 1 })
	let statementsApplied = 0

	try {
		await sql.unsafe('BEGIN')
		await sql.unsafe(
			'CREATE TABLE IF NOT EXISTS _kora_migrations (id TEXT PRIMARY KEY, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL, applied_at BIGINT NOT NULL)',
		)
		const existing = (await sql.unsafe(
			`SELECT COUNT(*)::int AS count FROM _kora_migrations WHERE id = ${sqlLiteral(migrationId)}`,
		)) as Array<{ count: number }>
		if ((existing[0]?.count ?? 0) > 0) {
			await sql.unsafe('COMMIT')
			return {
				backend: 'postgres',
				statementsApplied: 0,
				historyRecorded: true,
				skipped: true,
			}
		}
		for (const statement of statements) {
			const directive = parseRelaxValueDomainDirective(statement)
			if (directive) {
				const expanded = await expandRelaxValueDomainForPostgres(
					directive,
					async (text) => (await sql.unsafe(text)) as Array<Record<string, unknown>>,
				)
				for (const alter of expanded) await sql.unsafe(alter)
			} else {
				await sql.unsafe(statement)
			}
			statementsApplied++
		}
		await sql.unsafe(
			`INSERT INTO _kora_migrations (id, from_version, to_version, applied_at) VALUES (${sqlLiteral(migrationId)}, ${fromVersion}, ${toVersion}, ${Date.now()}) ON CONFLICT (id) DO UPDATE SET from_version = EXCLUDED.from_version, to_version = EXCLUDED.to_version, applied_at = EXCLUDED.applied_at`,
		)
		await sql.unsafe('COMMIT')

		return {
			backend: 'postgres',
			statementsApplied,
			historyRecorded: true,
			skipped: false,
		}
	} catch (error) {
		try {
			await sql.unsafe('ROLLBACK')
		} catch {
			// best effort
		}
		throw error
	} finally {
		if (typeof sql.end === 'function') {
			await sql.end()
		}
	}
}

function sqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`
}

async function loadPostgresModule(): Promise<{
	default: (
		connectionString: string,
		options?: { max?: number },
	) => {
		unsafe: (query: string) => Promise<unknown>
		end?: () => Promise<void>
	}
}> {
	try {
		const dynamicImport = new Function('specifier', 'return import(specifier)') as (
			specifier: string,
		) => Promise<unknown>
		const mod = await dynamicImport('postgres')
		if (typeof mod === 'object' && mod !== null && 'default' in mod) {
			return mod as {
				default: (
					connectionString: string,
					options?: { max?: number },
				) => {
					unsafe: (query: string) => Promise<unknown>
					end?: () => Promise<void>
				}
			}
		}
		throw new Error('Invalid postgres module')
	} catch {
		throw new Error(
			'PostgreSQL migration apply requires the "postgres" package in the target project dependencies.',
		)
	}
}
