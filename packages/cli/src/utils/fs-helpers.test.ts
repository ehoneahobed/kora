import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTempDir } from '../../tests/fixtures/test-helpers'
import { directoryExists, findProjectRoot, findSchemaFile, resolveProjectBinary } from './fs-helpers'

describe('directoryExists', () => {
	let tempDir: { path: string; cleanup: () => Promise<void> }

	beforeEach(async () => {
		tempDir = await createTempDir()
	})

	afterEach(async () => {
		await tempDir.cleanup()
	})

	test('returns true for existing directory', async () => {
		expect(await directoryExists(tempDir.path)).toBe(true)
	})

	test('returns false for non-existent path', async () => {
		expect(await directoryExists(join(tempDir.path, 'nope'))).toBe(false)
	})
})

describe('findProjectRoot', () => {
	let tempDir: { path: string; cleanup: () => Promise<void> }

	beforeEach(async () => {
		tempDir = await createTempDir()
	})

	afterEach(async () => {
		await tempDir.cleanup()
	})

	test('finds project root with kora dependency', async () => {
		const pkg = { name: 'test', dependencies: { kora: '1.0.0' } }
		await writeFile(join(tempDir.path, 'package.json'), JSON.stringify(pkg))

		const result = await findProjectRoot(tempDir.path)
		expect(result).toBe(tempDir.path)
	})

	test('finds project root with @korajs/ scoped dependency', async () => {
		const pkg = { name: 'test', devDependencies: { '@korajs/react': '1.0.0' } }
		await writeFile(join(tempDir.path, 'package.json'), JSON.stringify(pkg))

		const result = await findProjectRoot(tempDir.path)
		expect(result).toBe(tempDir.path)
	})

	test('finds root from nested directory', async () => {
		const pkg = { name: 'test', dependencies: { kora: '1.0.0' } }
		await writeFile(join(tempDir.path, 'package.json'), JSON.stringify(pkg))
		const nested = join(tempDir.path, 'src', 'components')
		await mkdir(nested, { recursive: true })

		const result = await findProjectRoot(nested)
		expect(result).toBe(tempDir.path)
	})

	test('returns null when no kora project found', async () => {
		const pkg = { name: 'test', dependencies: { react: '18.0.0' } }
		await writeFile(join(tempDir.path, 'package.json'), JSON.stringify(pkg))

		const result = await findProjectRoot(tempDir.path)
		expect(result).toBeNull()
	})
})

describe('findSchemaFile', () => {
	let tempDir: { path: string; cleanup: () => Promise<void> }

	beforeEach(async () => {
		tempDir = await createTempDir()
	})

	afterEach(async () => {
		await tempDir.cleanup()
	})

	test('finds src/schema.ts', async () => {
		await mkdir(join(tempDir.path, 'src'), { recursive: true })
		await writeFile(join(tempDir.path, 'src', 'schema.ts'), 'export default {}')

		const result = await findSchemaFile(tempDir.path)
		expect(result).toBe(join(tempDir.path, 'src', 'schema.ts'))
	})

	test('finds schema.ts at root', async () => {
		await writeFile(join(tempDir.path, 'schema.ts'), 'export default {}')

		const result = await findSchemaFile(tempDir.path)
		expect(result).toBe(join(tempDir.path, 'schema.ts'))
	})

	test('returns null when no schema file found', async () => {
		const result = await findSchemaFile(tempDir.path)
		expect(result).toBeNull()
	})
})

describe('resolveProjectBinary', () => {
	let tempDir: { path: string; cleanup: () => Promise<void> }

	beforeEach(async () => {
		tempDir = await createTempDir()
	})

	afterEach(async () => {
		await tempDir.cleanup()
	})

	test('finds existing binary in node_modules/.bin', async () => {
		const binaryDir = join(tempDir.path, 'node_modules', '.bin')
		await mkdir(binaryDir, { recursive: true })
		await writeFile(join(binaryDir, 'vite'), '')

		const result = await resolveProjectBinary(tempDir.path, 'vite')
		expect(result).toBe(join(binaryDir, 'vite'))
	})

	test('returns null for missing binary', async () => {
		const result = await resolveProjectBinary(tempDir.path, 'tsx')
		expect(result).toBeNull()
	})
})
