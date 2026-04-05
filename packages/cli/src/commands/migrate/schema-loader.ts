import { spawn } from 'node:child_process'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SchemaDefinition } from '@korajs/core'
import { resolveProjectBinary } from '../../utils/fs-helpers'

/**
 * Loads a schema definition from a TS/JS module.
 */
export async function loadSchemaDefinition(
	schemaPath: string,
	projectRoot: string,
): Promise<SchemaDefinition> {
	const ext = extname(schemaPath)
	const moduleValue =
		ext === '.ts' || ext === '.mts' || ext === '.cts'
			? await loadTypeScriptModule(schemaPath, projectRoot)
			: await import(`${pathToFileURL(schemaPath).href}?t=${Date.now()}-${Math.random()}`)

	return extractSchema(moduleValue)
}

function extractSchema(value: unknown): SchemaDefinition {
	if (typeof value !== 'object' || value === null) {
		throw new Error('Schema module must export an object.')
	}

	const moduleRecord = value as Record<string, unknown>
	const candidate = moduleRecord.default ?? moduleRecord

	if (!isSchemaDefinition(candidate)) {
		throw new Error('Schema module must export a valid SchemaDefinition as default export.')
	}

	return candidate
}

function isSchemaDefinition(value: unknown): value is SchemaDefinition {
	if (typeof value !== 'object' || value === null) return false
	const object = value as Record<string, unknown>
	return (
		typeof object.version === 'number' &&
		typeof object.collections === 'object' &&
		object.collections !== null &&
		typeof object.relations === 'object' &&
		object.relations !== null
	)
}

async function loadTypeScriptModule(schemaPath: string, projectRoot: string): Promise<unknown> {
	const tsxBinary = await resolveProjectBinary(projectRoot, 'tsx')
	if (!tsxBinary) {
		throw new Error(
			`Schema file is TypeScript (${schemaPath}) but local "tsx" was not found. Install tsx in the project.`,
		)
	}

	const script = [
		"import { pathToFileURL } from 'node:url'",
		'const modulePath = process.argv[process.argv.length - 1]',
		'const mod = await import(pathToFileURL(modulePath).href)',
		'const value = mod.default ?? mod',
		'process.stdout.write(JSON.stringify(value))',
	].join(';')

	const output = await runCommand(tsxBinary, ['--eval', script, schemaPath], projectRoot)

	try {
		return JSON.parse(output)
	} catch {
		throw new Error(`Failed to parse schema module output for ${schemaPath}`)
	}
}

async function runCommand(command: string, args: string[], cwd: string): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: process.env,
		})

		let stdout = ''
		let stderr = ''

		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf-8')
		})

		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf-8')
		})

		child.on('error', (error) => {
			reject(error)
		})

		child.on('exit', (code) => {
			if (code === 0) {
				resolve(stdout.trim())
				return
			}

			reject(
				new Error(`Failed to load TypeScript schema (exit ${code ?? 'unknown'}): ${stderr.trim()}`),
			)
		})
	})
}
