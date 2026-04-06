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
		expect(srcFiles).toContain('index.css')

		// Verify package.json has correct name
		const pkgContent = await readFile(join(targetDir, 'package.json'), 'utf-8')
		const pkg: unknown = JSON.parse(pkgContent)
		expect(pkg).toHaveProperty('name', 'my-app')

		// Verify schema.ts has defineSchema
		const schema = await readFile(join(targetDir, 'src', 'schema.ts'), 'utf-8')
		expect(schema).toContain('defineSchema')
		expect(schema).toContain('todos')

		// Verify devtools enabled
		const main = await readFile(join(targetDir, 'src', 'main.tsx'), 'utf-8')
		expect(main).toContain('devtools: true')
	})

	test('react-sync: includes sync-specific files', async () => {
		const targetDir = join(tempDir.path, 'sync-app')
		await scaffoldTemplate('react-sync', targetDir, {
			projectName: 'sync-app',
			packageManager: 'npm',
			koraVersion: '0.2.0',
		})

		const files = await readdir(targetDir)
		expect(files).toContain('server.ts')

		// Verify sync config in main.tsx
		const main = await readFile(join(targetDir, 'src', 'main.tsx'), 'utf-8')
		expect(main).toContain('sync:')
		expect(main).toContain('ws://localhost:3001')
		expect(main).toContain('devtools: true')

		// Verify @korajs/server in devDependencies
		const pkgContent = await readFile(join(targetDir, 'package.json'), 'utf-8')
		expect(pkgContent).toContain('@korajs/server')

		// Verify SQLite server store
		const server = await readFile(join(targetDir, 'server.ts'), 'utf-8')
		expect(server).toContain('createSqliteServerStore')
	})

	test('react-tailwind: Tailwind setup without sync', async () => {
		const targetDir = join(tempDir.path, 'tw-app')
		await scaffoldTemplate('react-tailwind', targetDir, {
			projectName: 'tw-app',
			packageManager: 'pnpm',
			koraVersion: '0.1.0',
		})

		const files = await readdir(targetDir)
		expect(files).toContain('package.json')
		expect(files).toContain('vite.config.ts')
		expect(files).not.toContain('server.ts')

		// Tailwind deps present
		const pkg = await readFile(join(targetDir, 'package.json'), 'utf-8')
		expect(pkg).toContain('tailwindcss')
		expect(pkg).toContain('@tailwindcss/vite')
		expect(pkg).toContain('lucide-react')
		expect(pkg).not.toContain('@korajs/server')

		// CSS file uses Tailwind
		const css = await readFile(join(targetDir, 'src', 'index.css'), 'utf-8')
		expect(css).toContain('@import "tailwindcss"')

		// Vite config uses Tailwind plugin
		const vite = await readFile(join(targetDir, 'vite.config.ts'), 'utf-8')
		expect(vite).toContain('tailwindcss')

		// No sync config
		const main = await readFile(join(targetDir, 'src', 'main.tsx'), 'utf-8')
		expect(main).not.toContain('sync:')
		expect(main).toContain('devtools: true')
	})

	test('react-tailwind-sync: full featured template', async () => {
		const targetDir = join(tempDir.path, 'tw-sync-app')
		await scaffoldTemplate('react-tailwind-sync', targetDir, {
			projectName: 'tw-sync-app',
			packageManager: 'pnpm',
			koraVersion: '0.3.0',
		})

		const files = await readdir(targetDir)
		expect(files).toContain('package.json')
		expect(files).toContain('server.ts')
		expect(files).toContain('vite.config.ts')
		expect(files).toContain('kora.config.ts')
		expect(files).toContain('index.html')

		// Tailwind + sync deps
		const pkg = await readFile(join(targetDir, 'package.json'), 'utf-8')
		expect(pkg).toContain('tailwindcss')
		expect(pkg).toContain('lucide-react')
		expect(pkg).toContain('@korajs/server')
		expect(pkg).toContain('"tw-sync-app"')

		// Sync + devtools in main
		const main = await readFile(join(targetDir, 'src', 'main.tsx'), 'utf-8')
		expect(main).toContain('sync:')
		expect(main).toContain('devtools: true')

		// SQLite server store
		const server = await readFile(join(targetDir, 'server.ts'), 'utf-8')
		expect(server).toContain('createSqliteServerStore')

		// App uses sync status and lucide icons
		const app = await readFile(join(targetDir, 'src', 'App.tsx'), 'utf-8')
		expect(app).toContain('useSyncStatus')
		expect(app).toContain('lucide-react')
	})

	test('variable substitution applied correctly in all .hbs files', async () => {
		const targetDir = join(tempDir.path, 'subst-test')
		await scaffoldTemplate('react-tailwind-sync', targetDir, {
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
