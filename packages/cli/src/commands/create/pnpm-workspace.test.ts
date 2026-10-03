import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { renderPnpmWorkspace, writePnpmWorkspaceSettings } from './pnpm-workspace'

let dir: string | null = null
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true })
	dir = null
})

describe('pnpm workspace settings', () => {
	test('mirrors the template allow list in both pnpm 10 and pnpm 11+ forms', async () => {
		dir = mkdtempSync(join(tmpdir(), 'kora-pnpm-'))
		writeFileSync(
			join(dir, 'package.json'),
			JSON.stringify({
				pnpm: { onlyBuiltDependencies: ['esbuild', 'better-sqlite3', 'esbuild'] },
			}),
		)
		expect(await writePnpmWorkspaceSettings(dir)).toEqual(['better-sqlite3', 'esbuild'])
		const yaml = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf-8')
		expect(yaml).toContain("packages:\n  - '.'")
		expect(yaml).toContain("onlyBuiltDependencies:\n  - 'better-sqlite3'\n  - 'esbuild'")
		expect(yaml).toContain("allowBuilds:\n  'better-sqlite3': true\n  'esbuild': true")
	})

	test('without an allow list only the package root is written', () => {
		expect(renderPnpmWorkspace([])).not.toContain('allowBuilds:')
	})

	test('every template allows esbuild builds (vite and the CLI need it)', () => {
		const templates = resolve(__dirname, '../../../templates')
		for (const template of readdirSync(templates)) {
			const manifest = readFileSync(join(templates, template, 'package.json.hbs'), 'utf-8')
			expect(manifest, template).toMatch(/"onlyBuiltDependencies":\s*\[[^\]]*"esbuild"/)
		}
	})
})
