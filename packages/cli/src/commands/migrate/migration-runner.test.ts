import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTempDir } from '../../../tests/fixtures/test-helpers'
import { MigrationApplyError, runMigration } from './migration-runner'

describe('runMigration', () => {
	let tempDir: { path: string; cleanup: () => Promise<void> }

	beforeEach(async () => {
		tempDir = await createTempDir()
	})

	afterEach(async () => {
		await tempDir.cleanup()
	})

	test('applies migration statements to sqlite database', async () => {
		const dbPath = join(tempDir.path, 'migrate.db')
		const executed: string[] = []

		const report = await runMigration({
			sqlitePath: dbPath,
			migrationId: '001-v1-v2',
			fromVersion: 1,
			toVersion: 2,
			upStatements: [
				'CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, title TEXT NOT NULL)',
				"INSERT INTO todos (id, title) VALUES ('1', 'Hello')",
			],
			sqliteDriver: {
				open() {
					return {
						exec(sql: string) {
							executed.push(sql)
						},
						isMigrationApplied() {
							return false
						},
						close() {
							// noop
						},
					}
				},
			},
		})

		expect(report.backends).toEqual([
			{ backend: 'sqlite', statementsApplied: 2, historyRecorded: true, skipped: false },
		])

		expect(executed[0]).toBe('BEGIN')
		expect(executed[1]).toBe(
			'CREATE TABLE IF NOT EXISTS _kora_migrations (id TEXT PRIMARY KEY NOT NULL, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL, applied_at INTEGER NOT NULL)',
		)
		expect(executed[2]).toBe('CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, title TEXT NOT NULL)')
		expect(executed[3]).toBe("INSERT INTO todos (id, title) VALUES ('1', 'Hello')")
		expect(executed[4]?.startsWith("INSERT OR REPLACE INTO _kora_migrations (id, from_version, to_version, applied_at) VALUES ('001-v1-v2', 1, 2, ")).toBe(true)
		expect(executed[5]).toBe('COMMIT')
	})

	test('rolls back and throws MigrationApplyError on sqlite failure', async () => {
		const executed: string[] = []

		const promise = runMigration({
			sqlitePath: join(tempDir.path, 'migrate.db'),
			upStatements: ['CREATE TABLE test (id TEXT)', 'BAD SQL'],
			sqliteDriver: {
				open() {
					return {
						exec(sql: string) {
							executed.push(sql)
							if (sql === 'BAD SQL') {
								throw new Error('boom')
							}
						},
						isMigrationApplied() {
							return false
						},
						close() {
							// noop
						},
					}
				},
			},
		})

		await expect(promise).rejects.toBeInstanceOf(MigrationApplyError)
		expect(executed).toContain('ROLLBACK')
	})

	test('skips sqlite migration when already applied', async () => {
		const executed: string[] = []

		const report = await runMigration({
			sqlitePath: join(tempDir.path, 'migrate.db'),
			migrationId: '001-v1-v2',
			fromVersion: 1,
			toVersion: 2,
			upStatements: ['CREATE TABLE test (id TEXT)'],
			sqliteDriver: {
				open() {
					return {
						exec(sql: string) {
							executed.push(sql)
						},
						isMigrationApplied() {
							return true
						},
						close() {
							// noop
						},
					}
				},
			},
		})

		expect(report.backends).toEqual([
			{ backend: 'sqlite', statementsApplied: 0, historyRecorded: true, skipped: true },
		])
		expect(executed).toEqual([
			'BEGIN',
			'CREATE TABLE IF NOT EXISTS _kora_migrations (id TEXT PRIMARY KEY NOT NULL, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL, applied_at INTEGER NOT NULL)',
			'COMMIT',
		])
	})

	test('applies then skips postgres migration using history table checks', async () => {
		const applied = new Set<string>()

		const createPostgresClient = () => ({
			async unsafe(query: string): Promise<{ count: number }[] | undefined> {
				if (query.includes('SELECT COUNT(*)::int AS count FROM _kora_migrations WHERE id =')) {
					const idMatch = query.match(/WHERE id = '([^']+)'/)
					const id = idMatch?.[1] ?? ''
					return [{ count: applied.has(id) ? 1 : 0 }]
				}

				if (query.includes('INSERT INTO _kora_migrations')) {
					const idMatch = query.match(/VALUES \('([^']+)'/)
					if (idMatch?.[1]) {
						applied.add(idMatch[1])
					}
				}

				return undefined
			},
		})

		const first = await runMigration({
			postgresConnectionString: 'postgres://example',
			migrationId: '001-v1-v2',
			fromVersion: 1,
			toVersion: 2,
			upStatements: ['ALTER TABLE todos ADD COLUMN completed BOOLEAN'],
			postgresClientFactory: createPostgresClient,
		})

		const second = await runMigration({
			postgresConnectionString: 'postgres://example',
			migrationId: '001-v1-v2',
			fromVersion: 1,
			toVersion: 2,
			upStatements: ['ALTER TABLE todos ADD COLUMN completed BOOLEAN'],
			postgresClientFactory: createPostgresClient,
		})

		expect(first.backends).toEqual([
			{ backend: 'postgres', statementsApplied: 1, historyRecorded: true, skipped: false },
		])
		expect(second.backends).toEqual([
			{ backend: 'postgres', statementsApplied: 0, historyRecorded: true, skipped: true },
		])
	})
})
