import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTempDir } from '../../tests/fixtures/test-helpers'
import { type UpgradeLayout, writeFixtureProject } from '../../tests/fixtures/upgrade-projects'
import type { PackageManager } from '../types'
import {
	inspectProject,
	isKoraPackageName,
	rewriteYamlSpecLine,
	scanPnpmWorkspaceYaml,
} from './project'

describe('isKoraPackageName', () => {
	it('matches korajs and @korajs/* but not the scaffolder or look-alikes', () => {
		expect(isKoraPackageName('korajs')).toBe(true)
		expect(isKoraPackageName('@korajs/react')).toBe(true)
		expect(isKoraPackageName('create-kora-app')).toBe(false)
		expect(isKoraPackageName('kora')).toBe(false)
		expect(isKoraPackageName('@korajs/core@<1')).toBe(false)
		expect(isKoraPackageName('@kora/core')).toBe(false)
	})
})

describe('inspectProject', () => {
	const temps: Array<{ cleanup: () => Promise<void> }> = []
	afterEach(async () => {
		for (const temp of temps) await temp.cleanup()
		temps.length = 0
	})
	async function temp(): Promise<string> {
		const dir = await createTempDir()
		temps.push(dir)
		return dir.path
	}

	it.each<UpgradeLayout>(['npm', 'pnpm', 'yarn', 'bun'])(
		'detects %s from its lockfile and finds every Kora dependency',
		async (layout) => {
			const root = await temp()
			await writeFixtureProject(root, { layout })
			const project = await inspectProject(root, 'npm')
			expect(project.packageManager).toBe(layout)
			expect(project.packageManagerSource).toBe('lockfile')
			expect(project.installDir).toBe(root)
			expect(project.specifiers.map((s) => `${s.section}:${s.name}`).sort()).toEqual([
				'dependencies:@korajs/react',
				'dependencies:korajs',
				'devDependencies:@korajs/cli',
			])
			expect(project.warnings).toEqual([])
		},
	)

	it('prefers the packageManager field over a lockfile', async () => {
		const root = await temp()
		await writeFixtureProject(root, { layout: 'npm', extra: { packageManager: 'pnpm@9.15.0' } })
		const project = await inspectProject(root, 'npm')
		expect(project.packageManager).toBe('pnpm')
		expect(project.packageManagerSource).toBe('packageManager-field')
		expect(project.warnings.join(' ')).toContain('lockfile belongs to npm')
	})

	it('falls back, with a warning, when there is no lockfile', async () => {
		const root = await temp()
		await writeFixtureProject(root, { layout: 'npm', noLockfile: true })
		const project = await inspectProject(root, 'bun' satisfies PackageManager)
		expect(project.packageManager).toBe('bun')
		expect(project.packageManagerSource).toBe('fallback')
		expect(project.warnings[0]).toContain('No lockfile')
	})

	it('warns when several lockfiles are present', async () => {
		const root = await temp()
		await writeFixtureProject(root, { layout: 'pnpm' })
		await writeFile(join(root, 'yarn.lock'), '')
		const project = await inspectProject(root, 'npm')
		expect(project.packageManager).toBe('pnpm')
		expect(project.warnings[0]).toContain('Several lockfiles')
	})

	it('collects overrides and resolutions that would pin an old version', async () => {
		const root = await temp()
		await writeFixtureProject(root, {
			layout: 'pnpm',
			extra: {
				overrides: { '@korajs/core': '1.0.0-beta.10', lodash: '4.17.21' },
				pnpm: { overrides: { '@korajs/store': '1.0.0-beta.10' } },
				resolutions: { '@korajs/sync': '1.0.0-beta.10' },
			},
		})
		const project = await inspectProject(root, 'npm')
		const sections = project.specifiers.map((s) => `${s.section}:${s.name}`)
		expect(sections).toContain('overrides:@korajs/core')
		expect(sections).toContain('pnpm.overrides:@korajs/store')
		expect(sections).toContain('resolutions:@korajs/sync')
		expect(sections).not.toContain('overrides:lodash')
	})

	it('reads pnpm catalogs from a workspace file above the project and installs at the lockfile', async () => {
		const workspace = await temp()
		const app = join(workspace, 'apps', 'web')
		await mkdir(app, { recursive: true })
		await writeFile(join(workspace, 'pnpm-lock.yaml'), '')
		await writeFile(
			join(workspace, 'package.json'),
			JSON.stringify({ name: 'root', private: true }),
		)
		await writeFile(
			join(workspace, 'pnpm-workspace.yaml'),
			[
				'packages:',
				"  - 'apps/*'",
				'catalog:',
				"  '@korajs/core': ^1.0.0-beta.14",
				'  react: ^18.3.1',
				'',
			].join('\n'),
		)
		await writeFixtureProject(app, {
			layout: 'pnpm',
			noLockfile: true,
			dependencies: { korajs: 'catalog:', '@korajs/core': 'catalog:' },
			devDependencies: {},
		})
		const project = await inspectProject(app, 'npm')
		expect(project.packageManager).toBe('pnpm')
		expect(project.installDir).toBe(workspace)
		const catalog = project.specifiers.filter((s) => s.format === 'pnpm-workspace')
		expect(catalog).toHaveLength(1)
		expect(catalog[0]).toMatchObject({
			section: 'catalog',
			name: '@korajs/core',
			spec: '^1.0.0-beta.14',
		})
	})
})

describe('scanPnpmWorkspaceYaml', () => {
	const yaml = [
		'packages:',
		"  - 'packages/*'",
		'catalog:',
		"  '@korajs/core': ^1.0.0-beta.14 # pinned together",
		'  korajs: "1.0.0-beta.14"',
		'  react: ^18.3.1',
		'catalogs:',
		'  legacy:',
		"    '@korajs/react': ~1.0.0-beta.12",
		'  next:',
		"    '@korajs/react': ^1.0.0-canary.3",
		'overrides:',
		"  '@korajs/store': 1.0.0-beta.10",
		"  '@korajs/store@<1': 1.0.0-beta.10",
		'',
	].join('\n')

	it('finds catalog, named catalog and override entries with their line numbers', () => {
		const found = scanPnpmWorkspaceYaml(yaml, '/w/pnpm-workspace.yaml')
		expect(found.map((s) => [s.section, s.name, s.spec, s.line])).toEqual([
			['catalog', '@korajs/core', '^1.0.0-beta.14', 3],
			['catalog', 'korajs', '1.0.0-beta.14', 4],
			['catalogs.legacy', '@korajs/react', '~1.0.0-beta.12', 8],
			['catalogs.next', '@korajs/react', '^1.0.0-canary.3', 10],
			['overrides', '@korajs/store', '1.0.0-beta.10', 12],
		])
	})

	it('rewrites only the version, keeping quotes and trailing comments', () => {
		const lines = yaml.split('\n')
		expect(rewriteYamlSpecLine(lines[3] ?? '', '^1.0.0-beta.15')).toBe(
			"  '@korajs/core': ^1.0.0-beta.15 # pinned together",
		)
		expect(rewriteYamlSpecLine(lines[4] ?? '', '1.0.0-beta.15')).toBe('  korajs: "1.0.0-beta.15"')
	})
})
