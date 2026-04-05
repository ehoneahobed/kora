import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
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
