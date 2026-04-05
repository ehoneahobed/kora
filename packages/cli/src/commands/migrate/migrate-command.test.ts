import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createTempDir } from '../../../tests/fixtures/test-helpers'

describe('migrate command', () => {
	let tempDir: { path: string; cleanup: () => Promise<void> }
	let originalCwd: string

	beforeEach(async () => {
		tempDir = await createTempDir()
		originalCwd = process.cwd()
		process.chdir(tempDir.path)

		await writeFile(
			join(tempDir.path, 'package.json'),
			JSON.stringify({ name: 'app', dependencies: { kora: '0.0.0' } }),
		)
		await mkdir(join(tempDir.path, 'src'), { recursive: true })
	})

	afterEach(async () => {
		process.chdir(originalCwd)
		await tempDir.cleanup()
		vi.resetModules()
		vi.restoreAllMocks()
		vi.unmock('./migration-runner')
	})

	test('creates baseline snapshot when none exists', async () => {
		await writeFile(join(tempDir.path, 'src', 'schema.js'), schemaWithTitleOnly())

		const { migrateCommand } = await import('./migrate-command')
		await migrateCommand.run({ args: {} as never })

		const snapshot = await readFile(join(tempDir.path, 'kora', 'schema.snapshot.json'), 'utf-8')
		expect(snapshot).toContain('"version": 1')
		expect(snapshot).toContain('"todos"')
	})

	test('generates migration after schema change', async () => {
		await writeFile(join(tempDir.path, 'src', 'schema.js'), schemaWithTitleOnly())

		const { migrateCommand } = await import('./migrate-command')
		await migrateCommand.run({ args: {} as never })

		await writeFile(join(tempDir.path, 'src', 'schema.js'), schemaWithCompletedField())
		await migrateCommand.run({ args: {} as never })

		const migration = await readFile(
			join(tempDir.path, 'kora', 'migrations', '001-v1-to-v1.ts'),
			'utf-8',
		)
		expect(migration).toContain('export const up')
		expect(migration).toContain('completed')
	})

	test('applies pending migration files in filename order', async () => {
		const runMigration = vi.fn(async () => ({ backends: [] }))
		vi.doMock('./migration-runner', () => ({ runMigration }))

		const { migrateCommand } = await import('./migrate-command')

		await writeFile(join(tempDir.path, 'src', 'schema.js'), schemaWithTitleOnly())
		await migrateCommand.run({ args: {} as never })

		await mkdir(join(tempDir.path, 'kora', 'migrations'), { recursive: true })
		await writeFile(
			join(tempDir.path, 'kora', 'migrations', '002-v2-to-v3.ts'),
			migrationSource(['ALTER TABLE todos ADD COLUMN completed INTEGER'], 2, 3),
		)
		await writeFile(
			join(tempDir.path, 'kora', 'migrations', '001-v1-to-v2.ts'),
			migrationSource(['CREATE TABLE todos (id TEXT PRIMARY KEY)'], 1, 2),
		)

		await migrateCommand.run({ args: { apply: true } as never })

		expect(runMigration).toHaveBeenCalledTimes(2)
		expect(runMigration.mock.calls[0]?.[0]).toMatchObject({
			migrationId: '001-v1-to-v2',
			fromVersion: 1,
			toVersion: 2,
			upStatements: ['CREATE TABLE todos (id TEXT PRIMARY KEY)'],
		})
		expect(runMigration.mock.calls[1]?.[0]).toMatchObject({
			migrationId: '002-v2-to-v3',
			fromVersion: 2,
			toVersion: 3,
			upStatements: ['ALTER TABLE todos ADD COLUMN completed INTEGER'],
		})
	})

	test('requires --force for breaking changes in non-interactive mode', async () => {
		await writeFile(join(tempDir.path, 'src', 'schema.js'), schemaWithTitleOnly())

		const { migrateCommand } = await import('./migrate-command')
		await migrateCommand.run({ args: {} as never })

		await writeFile(join(tempDir.path, 'src', 'schema.js'), schemaWithoutTitleField())

		await expect(migrateCommand.run({ args: {} as never })).rejects.toThrow(
			'Breaking schema changes require confirmation',
		)
	})

	test('allows breaking changes with --force', async () => {
		await writeFile(join(tempDir.path, 'src', 'schema.js'), schemaWithTitleOnly())

		const { migrateCommand } = await import('./migrate-command')
		await migrateCommand.run({ args: {} as never })

		await writeFile(join(tempDir.path, 'src', 'schema.js'), schemaWithoutTitleField())
		await migrateCommand.run({ args: { force: true } as never })

		const migration = await readFile(
			join(tempDir.path, 'kora', 'migrations', '001-v1-to-v1.ts'),
			'utf-8',
		)
		expect(migration).toContain('DROP TABLE todos')
	})
})

function schemaWithTitleOnly(): string {
	return `
export default {
  version: 1,
  collections: {
    todos: {
      fields: {
        title: {
          kind: 'string',
          required: true,
          defaultValue: undefined,
          auto: false,
          enumValues: null,
          itemKind: null
        }
      },
      indexes: [],
      constraints: [],
      resolvers: {}
    }
  },
  relations: {}
}
`
}

function schemaWithCompletedField(): string {
	return `
export default {
  version: 1,
  collections: {
    todos: {
      fields: {
        title: {
          kind: 'string',
          required: true,
          defaultValue: undefined,
          auto: false,
          enumValues: null,
          itemKind: null
        },
        completed: {
          kind: 'boolean',
          required: false,
          defaultValue: false,
          auto: false,
          enumValues: null,
          itemKind: null
        }
      },
      indexes: [],
      constraints: [],
      resolvers: {}
    }
  },
  relations: {}
}
`
}

function schemaWithoutTitleField(): string {
	return `
export default {
  version: 1,
  collections: {
    todos: {
      fields: {
        completed: {
          kind: 'boolean',
          required: false,
          defaultValue: false,
          auto: false,
          enumValues: null,
          itemKind: null
        }
      },
      indexes: [],
      constraints: [],
      resolvers: {}
    }
  },
  relations: {}
}
`
}

function migrationSource(upStatements: string[], fromVersion: number, toVersion: number): string {
	return [
		`export const up = ${JSON.stringify(upStatements, null, 2)} as const`,
		'',
		'export const down = [] as const',
		'',
		`export const summary = ["v${fromVersion} -> v${toVersion}"] as const`,
		'',
		'export const containsBreakingChanges = false',
		'',
	].join('\n')
}
