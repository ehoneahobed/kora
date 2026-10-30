import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireRuntimePackage } from '../../../runtime/module-resolution'
import { type MigrationManifest, listMigrationManifests } from '../../migrate/migrate-command'
import {
	expandEvolveTableForPostgres,
	expandEvolveTableForSqlite,
	parseEvolveTableDirective,
} from '../../migrate/table-evolution-directive'
import {
	expandRelaxValueDomainForPostgres,
	expandRelaxValueDomainForSqlite,
	parseRelaxValueDomainDirective,
} from '../../migrate/value-domain-directive'
import type { DoctorCheckResult } from '../doctor-checks'
import { type DoctorDatabaseTarget, scrubSecrets } from './database'
import { SLOW_STARTUP_SECONDS, formatDuration } from './db-checks'

/** Check id of the `--dry-run-migrations` report. */
export const MIGRATION_DRY_RUN_CHECK_ID = 'db-migration-dry-run'

/** A Postgres lock held on one table for longer than this is called out. */
export const LOCK_WARN_MS = 5_000

/** Postgres `statement_timeout` guard for one dry-run statement. */
export const DRY_RUN_STATEMENT_TIMEOUT_MS = 120_000

/** Postgres relation lock modes, weakest first (the order of `pg_locks.mode` strength). */
const LOCK_STRENGTH = [
	'AccessShareLock',
	'RowShareLock',
	'RowExclusiveLock',
	'ShareUpdateExclusiveLock',
	'ShareLock',
	'ShareRowExclusiveLock',
	'ExclusiveLock',
	'AccessExclusiveLock',
] as const

type LockMode = (typeof LOCK_STRENGTH)[number]

/** What one step of a migration does, for the report. */
export type DryRunStepKind =
	| 'evolve-table'
	| 'relax-value-domain'
	| 'create-table'
	| 'alter-table'
	| 'create-index'
	| 'drop'
	| 'sql'

/** One migration statement, run once against the copy (or inside the rolled-back transaction). */
export interface DryRunStep {
	migrationId: string
	/** 1-based position inside the migration. */
	index: number
	kind: DryRunStepKind
	/** Short description (the SQL text is not echoed whole). */
	description: string
	/** The table the step changes, when it names one. */
	table: string | null
	/** Rows the table held before the step (an estimate on Postgres); null when unknown or new. */
	rowsTouched: number | null
	/** SQL statements the step expanded to against this database's live catalog. */
	expandedStatements: number
	durationMs: number
	/** Strongest lock the transaction holds on the table after the step (Postgres). */
	lock: LockMode | null
}

/** A table that stays locked, and for how long, in the real transaction (Postgres). */
export interface DryRunLockWindow {
	migrationId: string
	table: string
	mode: LockMode
	/** From the step that took the lock to the end of the migration's transaction. */
	heldMs: number
}

/** The result of a dry run. */
export interface MigrationDryRunReport {
	dialect: 'postgres' | 'sqlite'
	/** Ids of the generated migrations this database has no record of, in order. */
	pending: string[]
	steps: DryRunStep[]
	totalMs: number
	locks: DryRunLockWindow[]
	/** The step that failed (later steps did not run), when one did. */
	failure: { migrationId: string; index: number; message: string } | null
	/** Size of the database file that was copied (SQLite). */
	copiedBytes: number | null
}

/** A database connection the dry run can write to; SQLite copy or Postgres transaction. */
interface DryRunConnection {
	exec(sql: string): Promise<void>
	query(sql: string): Promise<Array<Record<string, unknown>>>
}

/** Seams for tests: file copy, drivers and the clock. */
export interface DryRunDeps {
	listManifests(dir: string): Promise<MigrationManifest[]>
	/** Milliseconds, monotonic. */
	now(): number
	/** SQLite: copy the database file (and its WAL) to a private directory, open the copy. */
	openSqliteCopy(
		path: string,
		projectRoot: string,
	): Promise<{
		connection: DryRunConnection
		bytes: number
		close(): Promise<void>
	}>
	/** Postgres: one connection that BEGIN / ROLLBACK can share. */
	openPostgres(
		url: string,
		projectRoot: string,
	): Promise<{
		connection: DryRunConnection
		close(): Promise<void>
	}>
}

interface SqliteHandle {
	exec(sql: string): void
	prepare(sql: string): { all(): Array<Record<string, unknown>> }
	close(): void
}

interface PostgresHandle {
	unsafe(query: string): Promise<unknown>
	end(options?: { timeout?: number }): Promise<void>
}

/** The real drivers: `better-sqlite3` on a private copy of the file, `postgres` on one connection. */
export const defaultDryRunDeps: DryRunDeps = {
	listManifests: listMigrationManifests,
	now: () => performance.now(),
	async openSqliteCopy(path, projectRoot) {
		const Database = requireRuntimePackage('better-sqlite3', projectRoot) as new (
			path: string,
		) => SqliteHandle
		const directory = await mkdtemp(join(tmpdir(), 'kora-doctor-dry-run-'))
		const copy = join(directory, 'copy.db')
		try {
			await copyFile(path, copy)
			// A WAL-mode database keeps its latest writes in the -wal file: leave it out and the
			// copy would be an older database than the one the migration runs on.
			await copyFile(`${path}-wal`, `${copy}-wal`).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== 'ENOENT') throw error
			})
			const bytes = (await stat(copy)).size
			const db = new Database(copy)
			return {
				bytes,
				connection: {
					async exec(sql) {
						db.exec(sql)
					},
					async query(sql) {
						return db.prepare(sql).all()
					},
				},
				async close() {
					try {
						db.close()
					} finally {
						await rm(directory, { recursive: true, force: true })
					}
				},
			}
		} catch (error) {
			await rm(directory, { recursive: true, force: true })
			throw error
		}
	},
	async openPostgres(url, projectRoot) {
		const loaded = requireRuntimePackage('postgres', projectRoot) as
			| ((url: string, options: Record<string, unknown>) => PostgresHandle)
			| { default: (url: string, options: Record<string, unknown>) => PostgresHandle }
		const factory = typeof loaded === 'function' ? loaded : loaded.default
		const client = factory(url, {
			// BEGIN, the statements and ROLLBACK must share one connection.
			max: 1,
			onnotice: () => {},
			connect_timeout: 15,
			idle_timeout: 5,
			connection: { application_name: 'kora-doctor-dry-run' },
		})
		return {
			connection: {
				async exec(sql) {
					await client.unsafe(sql)
				},
				async query(sql) {
					return (await client.unsafe(sql)) as Array<Record<string, unknown>>
				},
			},
			async close() {
				await client.end({ timeout: 5 })
			},
		}
	},
}

function quote(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`
}

function literal(value: string): string {
	return `'${value.replaceAll("'", "''")}'`
}

/** Classify a statement and name the table it changes, without running it. */
export function describeStatement(statement: string): {
	kind: DryRunStepKind
	description: string
	table: string | null
} {
	const relax = parseRelaxValueDomainDirective(statement)
	if (relax) {
		return {
			kind: 'relax-value-domain',
			description: `relax the value domain of ${relax.table}`,
			table: relax.table,
		}
	}
	const evolve = parseEvolveTableDirective(statement)
	if (evolve) {
		const parts = [
			...Object.keys(evolve.add).map((field) => `add ${field}`),
			...evolve.drop.map((field) => `drop ${field}`),
			...Object.entries(evolve.change).map(
				([field, change]) => `change ${field} ${change.from.kind} -> ${change.to.kind}`,
			),
			...evolve.addIndexes.map((field) => `index ${field}`),
			...evolve.removeIndexes.map((field) => `unindex ${field}`),
		]
		return {
			kind: 'evolve-table',
			description: `evolve ${evolve.table}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}`,
			table: evolve.table,
		}
	}
	const text = statement.trim().replace(/\s+/g, ' ')
	const name = '"?([A-Za-z0-9_]+)"?'
	const short = text.length > 90 ? `${text.slice(0, 87)}...` : text
	const create = text.match(new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?${name}`, 'i'))
	if (create) return { kind: 'create-table', description: short, table: create[1] ?? null }
	const alter = text.match(new RegExp(`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${name}`, 'i'))
	if (alter) return { kind: 'alter-table', description: short, table: alter[1] ?? null }
	const index = text.match(new RegExp(`^CREATE (?:UNIQUE )?INDEX .*? ON ${name}`, 'i'))
	if (index) return { kind: 'create-index', description: short, table: index[1] ?? null }
	const drop = text.match(new RegExp(`^DROP (?:TABLE|INDEX) (?:IF EXISTS )?${name}`, 'i'))
	if (drop) return { kind: 'drop', description: short, table: drop[1] ?? null }
	return { kind: 'sql', description: short, table: null }
}

/** The lock a statement takes when `pg_locks` cannot be read (static knowledge of Postgres DDL). */
function staticLock(kind: DryRunStepKind): LockMode | null {
	switch (kind) {
		case 'evolve-table':
		case 'relax-value-domain':
		case 'alter-table':
		case 'drop':
			return 'AccessExclusiveLock'
		case 'create-index':
			return 'ShareLock'
		default:
			return null
	}
}

function strongest(modes: string[]): LockMode | null {
	let best = -1
	for (const mode of modes) {
		best = Math.max(best, LOCK_STRENGTH.indexOf(mode as LockMode))
	}
	return best >= 0 ? (LOCK_STRENGTH[best] ?? null) : null
}

/**
 * Run every migration this database has not recorded, against a copy (SQLite) or inside a
 * transaction that is rolled back (Postgres), and time each step on the real data volume.
 *
 * SQLite works on a private copy of the file in the temp directory, which is deleted
 * afterwards; the live file is only read. Postgres runs `BEGIN`, the same statements
 * `kora migrate --apply` runs, then `ROLLBACK`, with `statement_timeout` and `lock_timeout`
 * guards. Nothing is committed on either. This does not stop the migration from running
 * later, and never throws for a migration that fails: the failure is in the report.
 *
 * @param target - From `parseDoctorDatabaseUrl`
 * @param migrationsDir - Directory of the generated migrations
 * @param projectRoot - The app, whose dependencies provide the driver
 * @param deps - Driver and clock seams (tests)
 * @throws {Error} When the database or a driver cannot be opened
 */
export async function dryRunMigrations(
	target: DoctorDatabaseTarget,
	migrationsDir: string,
	projectRoot: string,
	deps: DryRunDeps = defaultDryRunDeps,
): Promise<MigrationDryRunReport> {
	const manifests = await deps.listManifests(migrationsDir)
	const report: MigrationDryRunReport = {
		dialect: target.dialect,
		pending: [],
		steps: [],
		totalMs: 0,
		locks: [],
		failure: null,
		copiedBytes: null,
	}
	if (manifests.length === 0) return report

	if (target.dialect === 'sqlite') {
		const opened = await deps.openSqliteCopy(target.location, projectRoot)
		report.copiedBytes = opened.bytes
		try {
			await runSqliteDryRun(opened.connection, manifests, report, deps)
		} finally {
			await opened.close()
		}
		return report
	}

	const opened = await deps.openPostgres(target.location, projectRoot)
	try {
		await runPostgresDryRun(opened.connection, manifests, report, deps)
	} finally {
		await opened.close()
	}
	return report
}

async function recordedMigrations(
	connection: DryRunConnection,
	dialect: 'postgres' | 'sqlite',
): Promise<Set<string>> {
	const exists =
		dialect === 'postgres'
			? "SELECT 1 AS found FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = '_kora_migrations'"
			: "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = '_kora_migrations'"
	if ((await connection.query(exists)).length === 0) return new Set()
	return new Set(
		(await connection.query('SELECT id FROM _kora_migrations')).map((r) => String(r.id)),
	)
}

async function rowCount(
	connection: DryRunConnection,
	dialect: 'postgres' | 'sqlite',
	table: string,
): Promise<number | null> {
	try {
		if (dialect === 'sqlite') {
			const rows = await connection.query(`SELECT COUNT(*) AS n FROM ${quote(table)}`)
			return Number(rows[0]?.n ?? 0)
		}
		// pg_class.reltuples is the planner's estimate and costs nothing; -1 means never analyzed.
		const rows = await connection.query(
			`SELECT reltuples::bigint AS n FROM pg_class WHERE oid = to_regclass(${literal(quote(table))})`,
		)
		if (rows.length === 0) return null
		const estimate = Number(rows[0]?.n ?? -1)
		if (estimate >= 0) return estimate
		const exact = await connection.query(`SELECT COUNT(*)::bigint AS n FROM ${quote(table)}`)
		return Number(exact[0]?.n ?? 0)
	} catch {
		// The table does not exist yet (created by this migration or by the server on start).
		return null
	}
}

async function runSqliteDryRun(
	connection: DryRunConnection,
	manifests: MigrationManifest[],
	report: MigrationDryRunReport,
	deps: DryRunDeps,
): Promise<void> {
	const recorded = await recordedMigrations(connection, 'sqlite')
	const pending = manifests.filter((manifest) => !recorded.has(manifest.id))
	report.pending = pending.map((manifest) => manifest.id)
	if (pending.length === 0) return

	// The table-rebuild procedure `kora migrate --apply` uses needs foreign keys off, and the
	// pragma is a no-op inside a transaction.
	await connection.exec('PRAGMA foreign_keys = OFF')
	const started = deps.now()
	const catalog = (text: string): Promise<Array<Record<string, unknown>>> => connection.query(text)
	try {
		await connection.exec('BEGIN')
		for (const manifest of pending) {
			let index = 0
			for (const statement of manifest.up) {
				index++
				const described = describeStatement(statement)
				const rows = described.table ? await rowCount(connection, 'sqlite', described.table) : null
				const stepStart = deps.now()
				let expanded = 1
				try {
					const relax = parseRelaxValueDomainDirective(statement)
					const evolve = relax ? null : parseEvolveTableDirective(statement)
					if (relax) {
						const sql = await expandRelaxValueDomainForSqlite(relax, catalog)
						expanded = sql.length
						for (const text of sql) await connection.exec(text)
					} else if (evolve) {
						const sql = await expandEvolveTableForSqlite(evolve, catalog, Date.now())
						expanded = sql.length
						for (const text of sql) await connection.exec(text)
					} else {
						await connection.exec(statement)
					}
				} catch (error) {
					report.failure = {
						migrationId: manifest.id,
						index,
						message: error instanceof Error ? error.message : String(error),
					}
					return
				}
				report.steps.push({
					migrationId: manifest.id,
					index,
					...described,
					rowsTouched: rows,
					expandedStatements: expanded,
					durationMs: deps.now() - stepStart,
					lock: null,
				})
			}
		}
		const violations = await connection.query('PRAGMA foreign_key_check')
		if (violations.length > 0) {
			report.failure = {
				migrationId: report.pending[report.pending.length - 1] ?? '',
				index: 0,
				message: `${violations.length} foreign key violation(s) after the table rebuilds (first: ${JSON.stringify(violations[0])}); the real run refuses to commit these.`,
			}
		}
	} finally {
		report.totalMs = deps.now() - started
		try {
			await connection.exec('ROLLBACK')
		} catch {
			// the copy is deleted next; a failed BEGIN leaves nothing to end
		}
	}
}

async function runPostgresDryRun(
	connection: DryRunConnection,
	manifests: MigrationManifest[],
	report: MigrationDryRunReport,
	deps: DryRunDeps,
): Promise<void> {
	let begun = false
	const started = deps.now()
	try {
		await connection.exec('BEGIN')
		begun = true
		// Guards first: a statement stuck behind the server's own locks, or one that runs
		// away on a big table, is cut off instead of holding production connections.
		await connection.exec(`SET LOCAL statement_timeout = '${DRY_RUN_STATEMENT_TIMEOUT_MS}ms'`)
		await connection.exec("SET LOCAL lock_timeout = '10s'")
		await connection.exec("SET LOCAL idle_in_transaction_session_timeout = '5min'")
		const recorded = await recordedMigrations(connection, 'postgres')
		const pending = manifests.filter((manifest) => !recorded.has(manifest.id))
		report.pending = pending.map((manifest) => manifest.id)
		const query = (text: string): Promise<Array<Record<string, unknown>>> => connection.query(text)

		for (const manifest of pending) {
			const manifestStart = deps.now()
			const lockStarts = new Map<string, { at: number; mode: LockMode }>()
			let index = 0
			for (const statement of manifest.up) {
				index++
				const described = describeStatement(statement)
				const rows = described.table
					? await rowCount(connection, 'postgres', described.table)
					: null
				const stepStart = deps.now()
				let expanded = 1
				try {
					const relax = parseRelaxValueDomainDirective(statement)
					const evolve = relax ? null : parseEvolveTableDirective(statement)
					if (relax) {
						const sql = await expandRelaxValueDomainForPostgres(relax, query)
						expanded = sql.length
						for (const text of sql) await connection.exec(text)
					} else if (evolve) {
						const sql = await expandEvolveTableForPostgres(evolve, query, Date.now())
						expanded = sql.length
						for (const text of sql) await connection.exec(text)
					} else {
						if (/^\s*CREATE\s+TABLE\s+"?_kora_mig_[A-Za-z0-9_]+_new"?/i.test(statement)) {
							throw new Error(
								`${manifest.id} is a SQLite-only table rebuild from an older \`kora migrate\`; regenerate it before applying to Postgres.`,
							)
						}
						await connection.exec(statement)
					}
				} catch (error) {
					report.failure = {
						migrationId: manifest.id,
						index,
						message: error instanceof Error ? error.message : String(error),
					}
					return
				}
				const durationMs = deps.now() - stepStart
				let lock: LockMode | null = null
				if (described.table) {
					lock = await heldLock(connection, described.table, described.kind)
					const first = lockStarts.get(described.table)
					if (lock && (!first || LOCK_STRENGTH.indexOf(lock) > LOCK_STRENGTH.indexOf(first.mode))) {
						lockStarts.set(described.table, { at: stepStart, mode: lock })
					}
				}
				report.steps.push({
					migrationId: manifest.id,
					index,
					...described,
					rowsTouched: rows,
					expandedStatements: expanded,
					durationMs,
					lock,
				})
			}
			const manifestEnd = deps.now()
			for (const [table, { at, mode }] of lockStarts) {
				if (mode === 'AccessExclusiveLock' || mode === 'ExclusiveLock' || mode === 'ShareLock') {
					report.locks.push({
						migrationId: manifest.id,
						table,
						mode,
						heldMs: manifestEnd - Math.max(at, manifestStart),
					})
				}
			}
		}
	} finally {
		report.totalMs = deps.now() - started
		if (begun) {
			try {
				await connection.exec('ROLLBACK')
			} catch {
				// the connection is closed next, which also ends the transaction
			}
		}
	}
}

async function heldLock(
	connection: DryRunConnection,
	table: string,
	kind: DryRunStepKind,
): Promise<LockMode | null> {
	try {
		const rows = await connection.query(
			`SELECT l.mode::text AS mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND c.oid = to_regclass(${literal(quote(table))})`,
		)
		const held = strongest(rows.map((row) => String(row.mode)))
		if (held) return held
	} catch {
		// fall back to what the statement is known to take
	}
	return staticLock(kind)
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? '' : 's'}`
}

function describeLock(mode: LockMode): string {
	switch (mode) {
		case 'AccessExclusiveLock':
			return 'ACCESS EXCLUSIVE (blocks every read and write of the table)'
		case 'ExclusiveLock':
			return 'EXCLUSIVE (blocks writes and most reads)'
		case 'ShareLock':
			return 'SHARE (blocks writes while an index is built)'
		default:
			return mode
	}
}

/**
 * Turn a dry-run report into the doctor result. `warn` for a step that failed, an
 * estimated duration over 60 s, or a Postgres table locked for over 5 s; everything
 * else passes. A dry run refuses nothing by itself: `--strict` is what turns a warning
 * into a failing exit code.
 */
export function formatMigrationDryRun(
	report: MigrationDryRunReport,
	target: Pick<DoctorDatabaseTarget, 'displayName' | 'dialect'>,
): DoctorCheckResult {
	const id = MIGRATION_DRY_RUN_CHECK_ID
	const title = 'Migration dry run'
	if (report.pending.length === 0) {
		return {
			id,
			title,
			status: 'pass',
			message: 'No generated migration is pending on this database; nothing to dry run.',
		}
	}
	const where =
		target.dialect === 'sqlite'
			? `on a copy of the file (${Math.round((report.copiedBytes ?? 0) / 1024)} KiB, deleted afterwards)`
			: 'inside a transaction that was rolled back'
	const lines = report.steps.map((step) => {
		const rows =
			step.rowsTouched === null
				? ''
				: ` over ${step.rowsTouched.toLocaleString('en-US')} row(s)${target.dialect === 'postgres' ? ' (estimate)' : ''}`
		const lock = step.lock ? `, lock ${step.lock}` : ''
		return `${step.migrationId} #${step.index} ${step.description}${rows}: ${formatDuration(step.durationMs / 1000)}${lock}`
	})
	const rowsTotal = report.steps.reduce((sum, step) => sum + (step.rowsTouched ?? 0), 0)
	const seconds = report.totalMs / 1000
	const head = `Dry run of ${plural(report.pending.length, 'pending migration')} (${report.pending.join(', ')}) ${where}`
	const problems: string[] = []
	const fixes: string[] = []

	if (report.failure) {
		const { migrationId, index, message } = report.failure
		problems.push(
			`step ${index} of ${migrationId} failed: ${message}. \`kora migrate --apply\` would fail the same way and roll back.`,
		)
		fixes.push('Fix or regenerate the failing migration before applying it.')
	}
	if (seconds >= SLOW_STARTUP_SECONDS) {
		problems.push(
			`the steps took ${formatDuration(seconds)}, over ${SLOW_STARTUP_SECONDS} s; plan the apply for a quiet window`,
		)
		fixes.push('Apply it with the server stopped (SQLite) or during low traffic (Postgres).')
	}
	const longLocks = report.locks.filter((lock) => lock.heldMs >= LOCK_WARN_MS)
	for (const lock of longLocks) {
		problems.push(
			`${lock.table} stays locked ${describeLock(lock.mode)} for about ${formatDuration(lock.heldMs / 1000)} in ${lock.migrationId}`,
		)
	}
	if (longLocks.length > 0) {
		fixes.push(
			'Run it in a quiet window, or split the change (add the column first, convert data later).',
		)
	}

	const timing = `${plural(report.steps.length, 'step')} ran in ${formatDuration(seconds)} over ${rowsTotal.toLocaleString('en-US')} row(s) touched${rowsTotal > 0 && seconds > 0 ? ` (about ${Math.round(rowsTotal / seconds).toLocaleString('en-US')} rows/s)` : ''}; expect about that long when applied here, longer on slower disks`
	const locks =
		report.locks.length > 0
			? ` Locks until commit: ${report.locks.map((lock) => `${lock.table} ${describeLock(lock.mode)} ~${formatDuration(lock.heldMs / 1000)}`).join('; ')}.`
			: ''
	const message = `${head}. ${lines.join('; ')}. ${timing}.${locks}${problems.length > 0 ? ` Attention: ${problems.join('; ')}.` : ''}`
	return {
		id,
		title,
		status: problems.length > 0 ? 'warn' : 'pass',
		message,
		...(fixes.length > 0 ? { fix: [...new Set(fixes)].join(' ') } : {}),
	}
}

/**
 * The `--dry-run-migrations` check as the doctor runs it: never throws; a database that
 * cannot be opened is a warning (the dry run is an extra, not the preflight).
 */
export async function checkMigrationDryRun(
	target: DoctorDatabaseTarget,
	migrationsDir: string,
	projectRoot: string,
	deps: DryRunDeps = defaultDryRunDeps,
): Promise<DoctorCheckResult> {
	try {
		return formatMigrationDryRun(
			await dryRunMigrations(target, migrationsDir, projectRoot, deps),
			target,
		)
	} catch (error) {
		return {
			id: MIGRATION_DRY_RUN_CHECK_ID,
			title: 'Migration dry run',
			status: 'warn',
			message: scrubSecrets(
				`The migration dry run could not run on ${target.displayName}: ${error instanceof Error ? error.message : String(error)}`,
				target,
			),
			fix: 'Check the database is reachable and the app has the driver installed (better-sqlite3 or postgres).',
		}
	}
}
