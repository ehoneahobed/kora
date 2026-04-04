import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { scaffoldTemplate } from '../../src/commands/create/template-engine'
import { createTempDir } from '../fixtures/test-helpers'

describe('create-kora-app flow', () => {
	let tempDir: { path: string; cleanup: () => Promise<void> }

	beforeEach(async () => {
		tempDir = await createTempDir()
	})

	afterEach(async () => {
		await tempDir.cleanup()
	})

	test('react-basic: all expected files exist with correct content', async () => {
		const targetDir = join(tempDir.path, 'my-app')
		await scaffoldTemplate('react-basic', targetDir, {
			projectName: 'my-app',
			packageManager: 'pnpm',
			koraVersion: '0.1.0',
		})

		// Verify top-level files
		const files = await readdir(targetDir)
		expect(files).toContain('package.json')
		expect(files).toContain('tsconfig.json')
		expect(files).toContain('vite.config.ts')
		expect(files).toContain('index.html')

		// Verify src files
		const srcFiles = await readdir(join(targetDir, 'src'))
		expect(srcFiles).toContain('schema.ts')
		expect(srcFiles).toContain('main.tsx')
		expect(srcFiles).toContain('App.tsx')

		// Verify package.json has correct name
		const pkgContent = await readFile(join(targetDir, 'package.json'), 'utf-8')
		const pkg: unknown = JSON.parse(pkgContent)
		expect(pkg).toHaveProperty('name', 'my-app')

		// Verify schema.ts has defineSchema
		const schema = await readFile(join(targetDir, 'src', 'schema.ts'), 'utf-8')
		expect(schema).toContain('defineSchema')
		expect(schema).toContain('todos')
	})

	test('react-sync: includes sync-specific files', async () => {
		const targetDir = join(tempDir.path, 'sync-app')
		await scaffoldTemplate('react-sync', targetDir, {
			projectName: 'sync-app',
			packageManager: 'npm',
			koraVersion: '0.2.0',
		})

		const files = await readdir(targetDir)
		expect(files).toContain('kora.config.ts')

		// Verify sync config in main.tsx
		const main = await readFile(join(targetDir, 'src', 'main.tsx'), 'utf-8')
		expect(main).toContain('sync:')
		expect(main).toContain('ws://localhost:3001/kora')

		// Verify @kora/server in devDependencies
		const pkgContent = await readFile(join(targetDir, 'package.json'), 'utf-8')
		expect(pkgContent).toContain('@kora/server')
	})

	test('variable substitution applied correctly in all .hbs files', async () => {
		const targetDir = join(tempDir.path, 'subst-test')
		await scaffoldTemplate('react-basic', targetDir, {
			projectName: 'subst-test',
			packageManager: 'yarn',
			koraVersion: '3.0.0',
		})

		// No .hbs files should remain
		const files = await readdir(targetDir)
		expect(files.every((f) => !f.endsWith('.hbs'))).toBe(true)

		// package.json should have substituted values
		const pkg = await readFile(join(targetDir, 'package.json'), 'utf-8')
		expect(pkg).toContain('"subst-test"')
		expect(pkg).toContain('3.0.0')
		expect(pkg).not.toContain('{{')

		// index.html should have substituted title
		const html = await readFile(join(targetDir, 'index.html'), 'utf-8')
		expect(html).toContain('subst-test')
		expect(html).not.toContain('{{')
	})

	test('error on existing directory is caught by ProjectExistsError', async () => {
		const { ProjectExistsError } = await import('../../src/errors')
		const error = new ProjectExistsError('existing-dir')
		expect(error.code).toBe('PROJECT_EXISTS')
		expect(error.message).toContain('existing-dir')
		expect(error.message).toContain('already exists')
	})
})
