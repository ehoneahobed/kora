import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTempDir } from '../../../tests/fixtures/test-helpers'
import { runMigration } from './migration-runner'

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

		await runMigration({
			sqlitePath: dbPath,
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
						close() {
							// noop
						},
					}
				},
			},
		})

		expect(executed).toEqual([
			'BEGIN',
			'CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, title TEXT NOT NULL)',
			"INSERT INTO todos (id, title) VALUES ('1', 'Hello')",
			'COMMIT',
		])
	})
})
