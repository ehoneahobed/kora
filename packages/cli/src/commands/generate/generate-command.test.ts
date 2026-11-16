import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import { createTempDir } from '../../../tests/fixtures/test-helpers'

const { loadSchemaDefinitionMock } = vi.hoisted(() => ({ loadSchemaDefinitionMock: vi.fn() }))
vi.mock('../migrate/schema-loader', () => ({ loadSchemaDefinition: loadSchemaDefinitionMock }))

describe('generate command', () => {
	test('generateCommand is defined with types subcommand', async () => {
		const { generateCommand } = await import('./generate-command')
		expect(generateCommand).toBeDefined()
	})

	test('types loads the schema through the shared loader (TypeScript schemas need tsx)', async () => {
		const tempDir = await createTempDir()
		try {
			await writeFile(
				join(tempDir.path, 'package.json'),
				JSON.stringify({ name: 'app', dependencies: { korajs: '1.0.0' } }),
			)
			await mkdir(join(tempDir.path, 'src'), { recursive: true })
			const schemaPath = join(tempDir.path, 'src', 'schema.ts')
			await writeFile(schemaPath, 'export default {}')
			loadSchemaDefinitionMock.mockResolvedValue(
				defineSchema({ version: 1, collections: { notes: { fields: { title: t.string() } } } }),
			)
			const cwd = vi.spyOn(process, 'cwd').mockReturnValue(tempDir.path)
			try {
				const { generateCommand } = await import('./generate-command')
				const subCommands = generateCommand.subCommands as Record<
					string,
					{ run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
				>
				await subCommands.types?.run({ args: { output: 'kora/generated/types.ts' } })
			} finally {
				cwd.mockRestore()
			}

			expect(loadSchemaDefinitionMock).toHaveBeenCalledWith(schemaPath, tempDir.path)
			const output = await readFile(join(tempDir.path, 'kora/generated/types.ts'), 'utf-8')
			expect(output).toContain('export interface NotesRecord')
		} finally {
			await tempDir.cleanup()
		}
	})
})
