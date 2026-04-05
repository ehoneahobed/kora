export interface RunMigrationOptions {
	upStatements: string[]
	sqlitePath?: string
	postgresConnectionString?: string
	projectRoot?: string
	sqliteDriver?: {
		open(path: string): {
			exec(sql: string): void
			close(): void
		}
	}
}

/**
 * Applies migration statements to configured backends.
 */
export async function runMigration(options: RunMigrationOptions): Promise<void> {
	if (options.sqlitePath) {
		await runSqliteMigration(options.sqlitePath, options.upStatements, options.projectRoot, options.sqliteDriver)
	}

	if (options.postgresConnectionString) {
		await runPostgresMigration(options.postgresConnectionString, options.upStatements)
	}
}

async function runSqliteMigration(
	path: string,
	statements: string[],
	projectRoot?: string,
	driverOverride?: RunMigrationOptions['sqliteDriver'],
): Promise<void> {
	const driver = driverOverride ?? (await loadSqliteDriver(projectRoot))
	const db = driver.open(path)

	try {
		db.exec('BEGIN')
		for (const statement of statements) {
			db.exec(statement)
		}
		db.exec('COMMIT')
	} catch (error) {
		try {
			db.exec('ROLLBACK')
		} catch {
			// best effort
		}
		throw error
	} finally {
		db.close()
	}
}

async function loadSqliteDriver(projectRoot?: string): Promise<{
	open(path: string): {
		exec(sql: string): void
		close(): void
	}
}> {
	try {
		const { createRequire } = await import('node:module')
		const requireFrom = createRequire(
			projectRoot ? `${projectRoot}/package.json` : import.meta.url,
		)
		const Database = requireFrom('better-sqlite3') as new (path: string) => {
			exec(sql: string): void
			close(): void
		}

		return {
			open(path: string) {
				return new Database(path)
			},
		}
	} catch {
		throw new Error(
			'SQLite migration apply requires the "better-sqlite3" package in the target project dependencies.',
		)
	}
}

async function runPostgresMigration(connectionString: string, statements: string[]): Promise<void> {
	const sqlModule = await loadPostgresModule()
	const sql = sqlModule.default(connectionString)

	try {
		await sql.unsafe('BEGIN')
		for (const statement of statements) {
			await sql.unsafe(statement)
		}
		await sql.unsafe('COMMIT')
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

async function loadPostgresModule(): Promise<{
	default: (connectionString: string) => {
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
				default: (connectionString: string) => {
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
