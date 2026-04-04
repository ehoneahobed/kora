import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { SchemaDefinition } from '@kora/core'
import { defineCommand } from 'citty'
import { InvalidProjectError, SchemaNotFoundError } from '../../errors'
import { findProjectRoot, findSchemaFile } from '../../utils/fs-helpers'
import { createLogger } from '../../utils/logger'
import { generateTypes } from './type-generator'

/**
 * The `generate` command with `types` subcommand.
 * Reads a schema file and generates TypeScript interfaces.
 */
export const generateCommand = defineCommand({
	meta: {
		name: 'generate',
		description: 'Generate code from your Kora schema',
	},
	subCommands: {
		types: defineCommand({
			meta: {
				name: 'types',
				description: 'Generate TypeScript types from your schema',
			},
			args: {
				schema: {
					type: 'string',
					description: 'Path to schema file',
				},
				output: {
					type: 'string',
					description: 'Output file path',
					default: 'kora/generated/types.ts',
				},
			},
			async run({ args }) {
				const logger = createLogger()

				// Find project root
				const projectRoot = await findProjectRoot()
				if (!projectRoot) {
					throw new InvalidProjectError(process.cwd())
				}

				// Find schema file
				let schemaPath: string
				if (args.schema && typeof args.schema === 'string') {
					schemaPath = resolve(args.schema)
				} else {
					const found = await findSchemaFile(projectRoot)
					if (!found) {
						throw new SchemaNotFoundError([
							'src/schema.ts',
							'schema.ts',
							'src/schema.js',
							'schema.js',
						])
					}
					schemaPath = found
				}

				logger.step(`Reading schema from ${schemaPath}...`)

				// Dynamic import the schema file
				const schemaModule: unknown = await import(schemaPath)
				const schema = extractSchema(schemaModule)

				if (!schema) {
					logger.error('Schema file must export a SchemaDefinition as the default export.')
					process.exitCode = 1
					return
				}

				// Generate types
				const output = generateTypes(schema)
				const outputFile = typeof args.output === 'string' ? args.output : 'kora/generated/types.ts'
				const outputPath = resolve(projectRoot, outputFile)

				await mkdir(dirname(outputPath), { recursive: true })
				await writeFile(outputPath, output, 'utf-8')

				logger.success(`Generated types at ${outputPath}`)
			},
		}),
	},
})

function extractSchema(mod: unknown): SchemaDefinition | null {
	if (typeof mod !== 'object' || mod === null) return null
	const record = mod as Record<string, unknown>

	// Check for default export
	const candidate = record.default ?? record
	if (isSchemaDefinition(candidate)) return candidate

	return null
}

function isSchemaDefinition(value: unknown): value is SchemaDefinition {
	if (typeof value !== 'object' || value === null) return false
	const obj = value as Record<string, unknown>
	return (
		typeof obj.version === 'number' &&
		typeof obj.collections === 'object' &&
		obj.collections !== null
	)
}
