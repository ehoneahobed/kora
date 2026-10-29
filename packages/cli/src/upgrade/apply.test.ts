import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTempDir } from '../../tests/fixtures/test-helpers'
import { applyUpgradeChanges, rewritePackageJson, rewriteWorkspaceYaml } from './apply'
import { buildUpgradePlan, classifySpecifiers } from './plan'
import { inspectProject } from './project'

const TARGET = { version: '1.0.0-beta.15', source: 'to' as const }

describe('applyUpgradeChanges', () => {
	const temps: Array<{ cleanup: () => Promise<void> }> = []
	afterEach(async () => {
		for (const temp of temps) await temp.cleanup()
		temps.length = 0
	})

	it('rewrites package.json keeping tab indentation, key order and the trailing newline', async () => {
		const dir = await createTempDir()
		temps.push(dir)
		const original = `${JSON.stringify(
			{
				name: 'app',
				dependencies: { react: '^18.3.1', korajs: '^1.0.0-beta.14' },
				overrides: { '@korajs/core': '1.0.0-beta.14' },
			},
			null,
			'\t',
		)}\n`
		await writeFile(join(dir.path, 'package.json'), original)
		const project = await inspectProject(dir.path, 'npm')
		const plan = buildUpgradePlan(classifySpecifiers(project.specifiers), TARGET)
		const written = await applyUpgradeChanges(plan.changes)
		expect(written).toEqual([join(dir.path, 'package.json')])
		const text = await readFile(join(dir.path, 'package.json'), 'utf-8')
		expect(text).toBe(
			original
				.replace('^1.0.0-beta.14', '^1.0.0-beta.15')
				.replace('"1.0.0-beta.14"', '"1.0.0-beta.15"'),
		)
	})

	it('rewrites a pnpm catalog without disturbing other lines', async () => {
		const dir = await createTempDir()
		temps.push(dir)
		const yaml = [
			'packages:',
			"  - 'packages/*'",
			'# shared versions',
			'catalog:',
			"  '@korajs/core': ^1.0.0-beta.14 # keep in step",
			'  react: ^18.3.1',
			'',
		].join('\n')
		await writeFile(join(dir.path, 'pnpm-workspace.yaml'), yaml)
		await writeFile(
			join(dir.path, 'package.json'),
			JSON.stringify({ name: 'root', dependencies: { '@korajs/core': 'catalog:' } }),
		)
		await writeFile(join(dir.path, 'pnpm-lock.yaml'), '')
		const project = await inspectProject(dir.path, 'npm')
		const plan = buildUpgradePlan(classifySpecifiers(project.specifiers), TARGET)
		await applyUpgradeChanges(plan.changes)
		expect(await readFile(join(dir.path, 'pnpm-workspace.yaml'), 'utf-8')).toBe(
			yaml.replace('^1.0.0-beta.14', '^1.0.0-beta.15'),
		)
	})
})

describe('rewrite helpers', () => {
	it('leave text alone when nothing matches', () => {
		const text = '{\n  "name": "x"\n}\n'
		expect(rewritePackageJson(text, [])).toBe(text)
		expect(rewriteWorkspaceYaml('catalog:\n', [])).toBe('catalog:\n')
	})

	it('preserve CRLF line endings in package.json', () => {
		const text = '{\r\n  "dependencies": {\r\n    "korajs": "1.0.0-beta.14"\r\n  }\r\n}\r\n'
		const change = {
			specifier: {
				format: 'package-json' as const,
				file: '/p/package.json',
				section: 'dependencies',
				path: ['dependencies'],
				name: 'korajs',
				spec: '1.0.0-beta.14',
			},
			style: 'exact' as const,
			from: '1.0.0-beta.14',
			to: '1.0.0-beta.15',
		}
		expect(rewritePackageJson(text, [change])).toBe(text.replace('beta.14', 'beta.15'))
	})
})

describe('rewritePackageJson keeps every other byte', () => {
	function change(path: string[], name: string, spec: string, to: string) {
		return {
			specifier: {
				format: 'package-json' as const,
				file: '/p/package.json',
				section: path.join('.'),
				path,
				name,
				spec,
			},
			style: 'caret' as const,
			from: spec,
			to,
		}
	}
	const bump = (): ReturnType<typeof change> =>
		change(['dependencies'], 'korajs', '^1.0.0-beta.14', '^1.0.0-beta.15')

	it('leaves inline arrays, integer-like keys, odd spacing and a BOM untouched', () => {
		const text =
			'﻿{\n  "files": ["dist", "src"],\n  "2": "b",\n  "1": "a",\n  "dependencies": {"korajs": "^1.0.0-beta.14",\n    "x": "^1.0.0"},\n  "note": "korajs ^1.0.0-beta.14"\n}\n'
		expect(rewritePackageJson(text, [bump()])).toBe(
			text.replace('"korajs": "^1.0.0-beta.14"', '"korajs": "^1.0.0-beta.15"'),
		)
	})

	it('refuses a key that appears twice instead of guessing which one npm uses', () => {
		const text = '{"dependencies": {"korajs": "^1.0.0-beta.14", "korajs": "^1.0.0-beta.14"}}'
		expect(() => rewritePackageJson(text, [bump()])).toThrow(/more than once/)
	})

	it('refuses when the value changed since it was read, or the file is not JSON', () => {
		expect(() =>
			rewritePackageJson('{"dependencies": {"korajs": "^1.0.0-beta.10"}}', [bump()]),
		).toThrow(/changed since it was read/)
		expect(() => rewritePackageJson('{ nope', [bump()])).toThrow(/not valid JSON/)
	})
})
