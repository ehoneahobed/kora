import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTempDir } from '../../../tests/fixtures/test-helpers'
import { getTemplatePath, scaffoldTemplate, substituteVariables } from './template-engine'

describe('substituteVariables', () => {
	test('replaces known variables', () => {
		const result = substituteVariables('Hello {{name}}!', { name: 'Kora' })
		expect(result).toBe('Hello Kora!')
	})

	test('replaces multiple occurrences', () => {
		const result = substituteVariables('{{x}} and {{y}}', { x: 'a', y: 'b' })
		expect(result).toBe('a and b')
	})

	test('preserves unknown variables', () => {
		const result = substituteVariables('Hello {{unknown}}!', {})
		expect(result).toBe('Hello {{unknown}}!')
	})

	test('handles empty template', () => {
		const result = substituteVariables('', { name: 'Kora' })
		expect(result).toBe('')
	})
})

describe('getTemplatePath', () => {
	test('returns path for react-basic template', () => {
		const path = getTemplatePath('react-basic')
		expect(path).toContain('templates')
		expect(path).toContain('react-basic')
	})

	test('returns path for react-sync template', () => {
		const path = getTemplatePath('react-sync')
		expect(path).toContain('templates')
		expect(path).toContain('react-sync')
	})
})

describe('scaffoldTemplate', () => {
	let tempDir: { path: string; cleanup: () => Promise<void> }

	beforeEach(async () => {
		tempDir = await createTempDir()
	})

	afterEach(async () => {
		await tempDir.cleanup()
	})

	test('scaffolds react-basic template with variable substitution', async () => {
		const targetDir = join(tempDir.path, 'my-app')
		await scaffoldTemplate('react-basic', targetDir, {
			projectName: 'my-app',
			packageManager: 'pnpm',
			koraVersion: '0.1.0',
		})

		// Check that .hbs files are processed and extension stripped
		const files = await readdir(targetDir)
		expect(files).toContain('package.json')
		expect(files).not.toContain('package.json.hbs')
		expect(files).toContain('index.html')
		expect(files).toContain('tsconfig.json')
		expect(files).toContain('vite.config.ts')
		expect(files).toContain('kora.config.ts')

		// Check variable substitution
		const pkg = await readFile(join(targetDir, 'package.json'), 'utf-8')
		expect(pkg).toContain('"my-app"')
		expect(pkg).toContain('"dev": "kora dev"')
		expect(pkg).not.toContain('{{projectName}}')

		// Check src directory was copied
		const srcFiles = await readdir(join(targetDir, 'src'))
		expect(srcFiles).toContain('schema.ts')
		expect(srcFiles).toContain('main.tsx')
		expect(srcFiles).toContain('App.tsx')
	})

	test('scaffolds react-sync template with server.ts', async () => {
		const targetDir = join(tempDir.path, 'sync-app')
		await scaffoldTemplate('react-sync', targetDir, {
			projectName: 'sync-app',
			packageManager: 'npm',
			koraVersion: '0.1.0',
		})

		const files = await readdir(targetDir)
		expect(files).toContain('server.ts')
		expect(files).toContain('package.json')
		expect(files).toContain('kora.config.ts')

		// Check sync-specific content in package.json
		const pkg = await readFile(join(targetDir, 'package.json'), 'utf-8')
		expect(pkg).toContain('@korajs/server')
		expect(pkg).toContain('"dev": "kora dev"')

		// Check sync config in main.tsx
		const main = await readFile(join(targetDir, 'src', 'main.tsx'), 'utf-8')
		expect(main).toContain('sync')
	})
})
