import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTempDir } from '../../../tests/fixtures/test-helpers'
import { InvalidProjectError, SchemaNotFoundError } from '../../errors'
import { findProjectRoot, findSchemaFile } from '../../utils/fs-helpers'

describe('migrate command', () => {
	let tempDir: { path: string; cleanup: () => Promise<void> }

	beforeEach(async () => {
		tempDir = await createTempDir()
	})

	afterEach(async () => {
		await tempDir.cleanup()
	})

	test('migrateCommand is defined', async () => {
		const { migrateCommand } = await import('./migrate-command')
		expect(migrateCommand).toBeDefined()
	})

	test('validates project root and schema file exist', async () => {
		// Setup a kora project with schema
		await writeFile(
			join(tempDir.path, 'package.json'),
			JSON.stringify({ name: 'test', dependencies: { kora: '1.0.0' } }),
		)
		await mkdir(join(tempDir.path, 'src'), { recursive: true })
		await writeFile(join(tempDir.path, 'src', 'schema.ts'), 'export default {}')

		const projectRoot = await findProjectRoot(tempDir.path)
		expect(projectRoot).toBe(tempDir.path)

		const schemaFile = await findSchemaFile(tempDir.path)
		expect(schemaFile).toBe(join(tempDir.path, 'src', 'schema.ts'))
	})
})
