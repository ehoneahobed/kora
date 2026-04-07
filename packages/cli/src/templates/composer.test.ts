import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTempDir } from '../../tests/fixtures/test-helpers'
import type { TemplateName } from '../types'
import {
	composeTemplateLayers,
	createCompatibilityLayerPlan,
	getTemplatePath,
	substituteVariables,
} from './composer'

describe('substituteVariables', () => {
	test('replaces known variables', () => {
		const result = substituteVariables('Hello {{name}}!', { name: 'Kora' })
		expect(result).toBe('Hello Kora!')
	})

	test('preserves unknown variables', () => {
		const result = substituteVariables('Hello {{unknown}}!', {})
		expect(result).toBe('Hello {{unknown}}!')
	})
})

describe('getTemplatePath', () => {
	test('resolves react-basic path', () => {
		const path = getTemplatePath('react-basic')
		expect(path).toContain('templates')
		expect(path).toContain('react-basic')
	})
})

describe('createCompatibilityLayerPlan', () => {
	test('creates compatibility plans for all v1 templates', () => {
		const templates: TemplateName[] = [
			'react-basic',
			'react-sync',
			'react-tailwind',
			'react-tailwind-sync',
		]
		for (const template of templates) {
			const plan = createCompatibilityLayerPlan(template)
			expect(plan.compatibilityTarget).toBe(template)
			expect(plan.layers.length).toBeGreaterThanOrEqual(6)
			expect(plan.layers[0]?.category).toBe('base')
		}
	})
})

describe('composeTemplateLayers', () => {
	let tempDir: { path: string; cleanup: () => Promise<void> }

	beforeEach(async () => {
		tempDir = await createTempDir()
	})

	afterEach(async () => {
		await tempDir.cleanup()
	})

	test('composes react-basic compatibility output', async () => {
		const targetDir = join(tempDir.path, 'react-basic-app')
		await composeTemplateLayers(createCompatibilityLayerPlan('react-basic'), targetDir, {
			projectName: 'react-basic-app',
			packageManager: 'pnpm',
			koraVersion: '0.1.0',
		})

		const files = await readdir(targetDir)
		expect(files).toContain('package.json')
		expect(files).not.toContain('server.ts')
		const pkg = await readFile(join(targetDir, 'package.json'), 'utf-8')
		expect(pkg).toContain('"react-basic-app"')
		expect(pkg).not.toContain('tailwindcss')
	})

	test('composes react-tailwind-sync compatibility output', async () => {
		const targetDir = join(tempDir.path, 'react-tailwind-sync-app')
		await composeTemplateLayers(createCompatibilityLayerPlan('react-tailwind-sync'), targetDir, {
			projectName: 'react-tailwind-sync-app',
			packageManager: 'pnpm',
			koraVersion: '0.2.0',
		})

		const files = await readdir(targetDir)
		expect(files).toContain('server.ts')
		expect(files).toContain('package.json')
		const pkg = await readFile(join(targetDir, 'package.json'), 'utf-8')
		expect(pkg).toContain('tailwindcss')
		expect(pkg).toContain('@korajs/server')
		const css = await readFile(join(targetDir, 'src', 'index.css'), 'utf-8')
		expect(css).toContain('@import "tailwindcss"')
	})
})
