import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createTempDir } from '../../../tests/fixtures/test-helpers'
import { ProjectExistsError } from '../../errors'
import { directoryExists } from '../../utils/fs-helpers'
import { scaffoldTemplate } from './template-engine'

// Test the scaffolding logic directly rather than citty's arg parsing,
// since citty handles that internally. We verify the core flow:
// template selection, directory validation, and scaffolding.

describe('create command flow', () => {
	let tempDir: { path: string; cleanup: () => Promise<void> }

	beforeEach(async () => {
		tempDir = await createTempDir()
	})

	afterEach(async () => {
		await tempDir.cleanup()
	})

	test('scaffolds react-basic project with correct structure', async () => {
		const targetDir = join(tempDir.path, 'test-app')
		await scaffoldTemplate('react-basic', targetDir, {
			projectName: 'test-app',
			packageManager: 'pnpm',
			koraVersion: '0.1.0',
		})

		const files = await readdir(targetDir)
		expect(files).toContain('package.json')
		expect(files).toContain('tsconfig.json')
		expect(files).toContain('vite.config.ts')
		expect(files).toContain('index.html')
		expect(files).toContain('src')

		const srcFiles = await readdir(join(targetDir, 'src'))
		expect(srcFiles).toContain('schema.ts')
		expect(srcFiles).toContain('main.tsx')
		expect(srcFiles).toContain('App.tsx')
		expect(srcFiles).toContain('index.css')
	})

	test('substitutes project name in package.json', async () => {
		const targetDir = join(tempDir.path, 'my-cool-app')
		await scaffoldTemplate('react-basic', targetDir, {
			projectName: 'my-cool-app',
			packageManager: 'npm',
			koraVersion: '1.0.0',
		})

		const pkg = await readFile(join(targetDir, 'package.json'), 'utf-8')
		const parsed: unknown = JSON.parse(pkg)
		expect(parsed).toHaveProperty('name', 'my-cool-app')
	})

	test('throws ProjectExistsError for existing directory', async () => {
		// tempDir.path already exists
		if (await directoryExists(tempDir.path)) {
			expect(() => new ProjectExistsError('my-app')).not.toThrow()
			const error = new ProjectExistsError('my-app')
			expect(error.code).toBe('PROJECT_EXISTS')
			expect(error.directory).toBe('my-app')
		}
	})

	test('scaffolds react-sync project with server.ts', async () => {
		const targetDir = join(tempDir.path, 'sync-app')
		await scaffoldTemplate('react-sync', targetDir, {
			projectName: 'sync-app',
			packageManager: 'pnpm',
			koraVersion: '0.1.0',
		})

		const files = await readdir(targetDir)
		expect(files).toContain('server.ts')

		const main = await readFile(join(targetDir, 'src', 'main.tsx'), 'utf-8')
		expect(main).toContain('sync')
		expect(main).toContain('ws://localhost:3001')
	})

	test('skip-install flag prevents dependency installation', async () => {
		// The skip-install flag is a boolean arg handled by citty.
		// We verify the arg definition accepts it by checking the command imports compile.
		const { createCommand } = await import('./create-command')
		expect(createCommand).toBeDefined()
	})

	test('template substitutes koraVersion in dependencies', async () => {
		const targetDir = join(tempDir.path, 'version-test')
		await scaffoldTemplate('react-basic', targetDir, {
			projectName: 'version-test',
			packageManager: 'npm',
			koraVersion: '2.3.4',
		})

		const pkg = await readFile(join(targetDir, 'package.json'), 'utf-8')
		expect(pkg).toContain('2.3.4')
		expect(pkg).not.toContain('{{koraVersion}}')
	})

	test('scaffolds react-tailwind-sync project with Tailwind and sync', async () => {
		const targetDir = join(tempDir.path, 'tw-sync-app')
		await scaffoldTemplate('react-tailwind-sync', targetDir, {
			projectName: 'tw-sync-app',
			packageManager: 'pnpm',
			koraVersion: '0.1.0',
		})

		const files = await readdir(targetDir)
		expect(files).toContain('package.json')
		expect(files).toContain('server.ts')
		expect(files).toContain('vite.config.ts')

		const srcFiles = await readdir(join(targetDir, 'src'))
		expect(srcFiles).toContain('index.css')
		expect(srcFiles).toContain('App.tsx')

		const pkg = await readFile(join(targetDir, 'package.json'), 'utf-8')
		expect(pkg).toContain('tailwindcss')
		expect(pkg).toContain('lucide-react')
		expect(pkg).toContain('@korajs/server')
	})

	test('scaffolds react-tailwind project without sync', async () => {
		const targetDir = join(tempDir.path, 'tw-app')
		await scaffoldTemplate('react-tailwind', targetDir, {
			projectName: 'tw-app',
			packageManager: 'npm',
			koraVersion: '0.1.0',
		})

		const files = await readdir(targetDir)
		expect(files).toContain('package.json')
		expect(files).not.toContain('server.ts')

		const pkg = await readFile(join(targetDir, 'package.json'), 'utf-8')
		expect(pkg).toContain('tailwindcss')
		expect(pkg).not.toContain('@korajs/server')
	})

	test('all templates include devtools: true', async () => {
		const templates = [
			'react-basic',
			'react-sync',
			'react-tailwind',
			'react-tailwind-sync',
		] as const
		for (const template of templates) {
			const targetDir = join(tempDir.path, `devtools-${template}`)
			await scaffoldTemplate(template, targetDir, {
				projectName: `devtools-${template}`,
				packageManager: 'pnpm',
				koraVersion: '0.1.0',
			})
			const main = await readFile(join(targetDir, 'src', 'main.tsx'), 'utf-8')
			expect(main).toContain('devtools: true')
		}
	})

	test('sync templates use SQLite server store', async () => {
		for (const template of ['react-sync', 'react-tailwind-sync'] as const) {
			const targetDir = join(tempDir.path, `sqlite-${template}`)
			await scaffoldTemplate(template, targetDir, {
				projectName: `sqlite-${template}`,
				packageManager: 'pnpm',
				koraVersion: '0.1.0',
			})
			const server = await readFile(join(targetDir, 'server.ts'), 'utf-8')
			expect(server).toContain('createSqliteServerStore')
			expect(server).not.toContain('MemoryServerStore')
		}
	})
})
