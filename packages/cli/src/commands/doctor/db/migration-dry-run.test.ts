import { describe, expect, it } from 'vitest'
import type { MigrationManifest } from '../../migrate/migrate-command'
import type { DoctorDatabaseTarget } from './database'
import {
	type DryRunDeps,
	LOCK_WARN_MS,
	checkMigrationDryRun,
	describeStatement,
	dryRunMigrations,
	formatMigrationDryRun,
} from './migration-dry-run'

type Row = Record<string, unknown>

function manifest(id: string, up: string[]): MigrationManifest {
	return {
		id,
		fromVersion: 1,
		toVersion: 2,
		up,
		down: [],
		summary: [],
		containsBreakingChanges: false,
	}
}

const pgTarget: DoctorDatabaseTarget = {
	dialect: 'postgres',
	location: 'postgres://u:secret@db.example.com/app',
	displayName: 'postgres://db.example.com/app',
	secrets: ['secret'],
}
const sqliteTarget: DoctorDatabaseTarget = {
	dialect: 'sqlite',
	location: '/data/kora.db',
	displayName: '/data/kora.db',
	secrets: [],
}

/** A scripted connection: records every statement, answers catalog queries from `answers`. */
function scripted(answers: Array<[RegExp, Row[] | Error]>): {
	statements: string[]
	connection: { exec(sql: string): Promise<void>; query(sql: string): Promise<Row[]> }
} {
	const statements: string[] = []
	return {
		statements,
		connection: {
			async exec(sql) {
				statements.push(sql)
				const hit = answers.find(([pattern]) => pattern.test(sql))
				if (hit?.[1] instanceof Error) throw hit[1]
			},
			async query(sql) {
				statements.push(sql)
				const hit = answers.find(([pattern]) => pattern.test(sql))
				if (hit?.[1] instanceof Error) throw hit[1]
				return hit ? (hit[1] as Row[]) : []
			},
		},
	}
}

/** A clock that advances by the scripted step each call. */
function clock(step: number): () => number {
	let t = 0
	return () => {
		t += step
		return t
	}
}

function depsFor(
	manifests: MigrationManifest[],
	script: ReturnType<typeof scripted>,
	now: () => number,
	extra: Partial<DryRunDeps> = {},
): DryRunDeps {
	return {
		listManifests: async () => manifests,
		now,
		openSqliteCopy: async () => ({
			connection: script.connection,
			bytes: 4096,
			close: async () => {
				script.statements.push('<closed copy>')
			},
		}),
		openPostgres: async () => ({
			connection: script.connection,
			close: async () => {
				script.statements.push('<closed connection>')
			},
		}),
		...extra,
	}
}

describe('describeStatement', () => {
	it('names the table and kind of plain SQL', () => {
		expect(describeStatement('ALTER TABLE "notes" ADD COLUMN "views" BIGINT')).toMatchObject({
			kind: 'alter-table',
			table: 'notes',
		})
		expect(describeStatement('CREATE UNIQUE INDEX idx ON notes (title)')).toMatchObject({
			kind: 'create-index',
			table: 'notes',
		})
		expect(describeStatement('CREATE TABLE IF NOT EXISTS "tags" (id TEXT)')).toMatchObject({
			kind: 'create-table',
			table: 'tags',
		})
		expect(describeStatement('SELECT 1')).toMatchObject({ kind: 'sql', table: null })
	})

	it('reads the evolve-table directive', () => {
		const directive = `--kora:evolve-table ${JSON.stringify({
			table: 'notes',
			add: { tags: { kind: 'array', itemKind: 'string' } },
			drop: ['old'],
			change: {},
			addIndexes: [],
			removeIndexes: [],
		})}`
		expect(describeStatement(directive)).toEqual({
			kind: 'evolve-table',
			description: 'evolve notes: add tags, drop old',
			table: 'notes',
		})
	})
})

describe('dryRunMigrations on Postgres', () => {
	const alter = 'ALTER TABLE "notes" ADD COLUMN "views" BIGINT'

	it('runs the steps in a transaction that is rolled back, with timeout guards', async () => {
		const script = scripted([
			[/reltuples/, [{ n: 120000 }]],
			[/pg_locks/, [{ mode: 'AccessExclusiveLock' }]],
		])
		const report = await dryRunMigrations(
			pgTarget,
			'/m',
			'/p',
			depsFor([manifest('001-v1-to-v2', [alter])], script, clock(100)),
		)
		expect(script.statements[0]).toBe('BEGIN')
		expect(script.statements[1]).toContain("statement_timeout = '120000ms'")
		expect(script.statements[2]).toContain("lock_timeout = '10s'")
		expect(script.statements).toContain(alter)
		expect(script.statements.at(-2)).toBe('ROLLBACK')
		expect(script.statements.at(-1)).toBe('<closed connection>')
		expect(script.statements.some((s) => /COMMIT/.test(s))).toBe(false)
		expect(report.pending).toEqual(['001-v1-to-v2'])
		expect(report.failure).toBeNull()
		expect(report.steps).toHaveLength(1)
		expect(report.steps[0]).toMatchObject({
			table: 'notes',
			rowsTouched: 120000,
			lock: 'AccessExclusiveLock',
		})
		expect(report.locks).toEqual([
			expect.objectContaining({ table: 'notes', mode: 'AccessExclusiveLock' }),
		])
	})

	it('skips migrations already recorded and runs nothing when none are pending', async () => {
		const script = scripted([
			[/information_schema/, [{ found: 1 }]],
			[/SELECT id FROM _kora_migrations/, [{ id: '001-v1-to-v2' }]],
		])
		const report = await dryRunMigrations(
			pgTarget,
			'/m',
			'/p',
			depsFor([manifest('001-v1-to-v2', [alter])], script, clock(1)),
		)
		expect(report.pending).toEqual([])
		expect(script.statements).not.toContain(alter)
		expect(formatMigrationDryRun(report, pgTarget).status).toBe('pass')
	})

	it('reports a failing step, stops there, and still rolls back', async () => {
		const script = scripted([
			[/ADD COLUMN/, new Error('canceling statement due to statement timeout')],
		])
		const report = await dryRunMigrations(
			pgTarget,
			'/m',
			'/p',
			depsFor(
				[manifest('001-v1-to-v2', [alter, 'ALTER TABLE "notes" ADD COLUMN "x" TEXT'])],
				script,
				clock(1),
			),
		)
		expect(report.failure).toEqual({
			migrationId: '001-v1-to-v2',
			index: 1,
			message: 'canceling statement due to statement timeout',
		})
		expect(report.steps).toHaveLength(0)
		expect(script.statements).toContain('ROLLBACK')
		const result = formatMigrationDryRun(report, pgTarget)
		expect(result.status).toBe('warn')
		expect(result.message).toContain('step 1 of 001-v1-to-v2 failed')
	})

	it('falls back to the known lock of the statement when pg_locks cannot be read', async () => {
		const script = scripted([[/pg_locks/, new Error('permission denied for view pg_locks')]])
		const report = await dryRunMigrations(
			pgTarget,
			'/m',
			'/p',
			depsFor([manifest('001-v1-to-v2', [alter])], script, clock(1)),
		)
		expect(report.steps[0]?.lock).toBe('AccessExclusiveLock')
	})

	it('warns about an ACCESS EXCLUSIVE lock held for several seconds, and refuses nothing', async () => {
		const script = scripted([[/pg_locks/, [{ mode: 'AccessExclusiveLock' }]]])
		const report = await dryRunMigrations(
			pgTarget,
			'/m',
			'/p',
			depsFor([manifest('001-v1-to-v2', [alter])], script, clock(LOCK_WARN_MS)),
		)
		const result = formatMigrationDryRun(report, pgTarget)
		expect(result.status).toBe('warn')
		expect(result.message).toContain('notes')
		expect(result.message).toContain('ACCESS EXCLUSIVE')
		expect(result.message).toContain('Locks until commit')
		expect(result.fix).toContain('quiet window')
	})

	it('passes a quick migration and states the duration and rows', async () => {
		const script = scripted([
			[/reltuples/, [{ n: 1000 }]],
			[/pg_locks/, [{ mode: 'AccessExclusiveLock' }]],
		])
		const report = await dryRunMigrations(
			pgTarget,
			'/m',
			'/p',
			depsFor([manifest('001-v1-to-v2', [alter])], script, clock(10)),
		)
		const result = formatMigrationDryRun(report, pgTarget)
		expect(result.id).toBe('db-migration-dry-run')
		expect(result.status).toBe('pass')
		expect(result.message).toContain('inside a transaction that was rolled back')
		expect(result.message).toContain('1,000 row(s)')
		expect(result.message).toContain('rows/s')
	})
})

describe('dryRunMigrations on SQLite', () => {
	it('runs on the copy, rolls back, and closes (deletes) the copy', async () => {
		const script = scripted([[/COUNT\(\*\)/, [{ n: 42 }]]])
		const report = await dryRunMigrations(
			sqliteTarget,
			'/m',
			'/p',
			depsFor(
				[manifest('001-v1-to-v2', ['ALTER TABLE "notes" ADD COLUMN "views" REAL'])],
				script,
				clock(5),
			),
		)
		expect(script.statements).toContain('PRAGMA foreign_keys = OFF')
		expect(script.statements).toContain('BEGIN')
		expect(script.statements.at(-2)).toBe('ROLLBACK')
		expect(script.statements.at(-1)).toBe('<closed copy>')
		expect(report.copiedBytes).toBe(4096)
		expect(report.steps[0]).toMatchObject({ rowsTouched: 42, lock: null })
		expect(report.locks).toEqual([])
		expect(formatMigrationDryRun(report, sqliteTarget).message).toContain('on a copy of the file')
	})

	it('reports foreign key violations the real run would refuse to commit', async () => {
		const script = scripted([[/PRAGMA foreign_key_check/, [{ table: 'notes', rowid: 1 }]]])
		const report = await dryRunMigrations(
			sqliteTarget,
			'/m',
			'/p',
			depsFor([manifest('001-v1-to-v2', ['SELECT 1'])], script, clock(1)),
		)
		expect(report.failure?.message).toContain('foreign key violation')
		expect(formatMigrationDryRun(report, sqliteTarget).status).toBe('warn')
	})
})

describe('checkMigrationDryRun', () => {
	it('is a pass with nothing to do when there are no generated migrations', async () => {
		const script = scripted([])
		const result = await checkMigrationDryRun(
			sqliteTarget,
			'/m',
			'/p',
			depsFor([], script, clock(1)),
		)
		expect(result.status).toBe('pass')
		expect(result.message).toContain('nothing to dry run')
		expect(script.statements).toEqual([])
	})

	it('turns an unopenable database into a warning without leaking the password', async () => {
		const result = await checkMigrationDryRun(
			pgTarget,
			'/m',
			'/p',
			depsFor([manifest('001-v1-to-v2', ['SELECT 1'])], scripted([]), clock(1), {
				openPostgres: async () => {
					throw new Error('password authentication failed for secret')
				},
			}),
		)
		expect(result.status).toBe('warn')
		expect(result.message).not.toContain('secret')
		expect(result.message).toContain('***')
	})
})
