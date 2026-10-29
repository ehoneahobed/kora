import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UpgradeError } from '../../src/errors'
import type { CommandRunner } from '../../src/upgrade/runner'
import {
	type UpgradeDependencies,
	type UpgradeOptions,
	runUpgrade,
} from '../../src/upgrade/upgrade'
import type { Logger } from '../../src/utils/logger'
import { createTempDir } from '../fixtures/test-helpers'
import {
	type UpgradeLayout,
	createFakeRegistry,
	writeFixtureProject,
} from '../fixtures/upgrade-projects'

const VERSIONS = ['1.0.0-beta.14', '1.0.0-beta.15', '1.0.0']

function silentLogger(lines: string[]): Logger {
	const record = (level: string) => (message: string) => {
		lines.push(`${level} ${message}`)
	}
	return {
		info: record('info'),
		success: record('success'),
		warn: record('warn'),
		error: record('error'),
		step: record('step'),
		blank: () => {},
		banner: () => {},
	}
}

interface Harness {
	deps: UpgradeDependencies
	commands: string[]
	lines: string[]
	lookupCalls: string[]
}

function harness(
	runner?: (command: string, args: string[]) => number,
	confirmAnswer = true,
	koraBinary = true,
): Harness {
	const commands: string[] = []
	const lines: string[] = []
	const lookup = createFakeRegistry({
		distTags: { latest: '1.0.0', beta: '1.0.0-beta.15' },
		versions: VERSIONS,
	})
	const runCommand: CommandRunner = async (command, args, cwd) => {
		commands.push(`${command} ${args.join(' ')} @${cwd}`)
		return runner ? runner(command, args) : 0
	}
	return {
		commands,
		lines,
		lookupCalls: lookup.calls,
		deps: {
			lookup,
			runCommand,
			confirm: async () => confirmAnswer,
			logger: silentLogger(lines),
			fallbackPackageManager: 'npm',
			hasKoraBinary: async () => koraBinary,
		},
	}
}

function options(projectRoot: string, overrides: Partial<UpgradeOptions> = {}): UpgradeOptions {
	return {
		projectRoot,
		dryRun: false,
		yes: true,
		allowDowngrade: false,
		applyCodemods: false,
		interactive: false,
		...overrides,
	}
}

describe('kora upgrade flow', () => {
	const temps: Array<{ cleanup: () => Promise<void> }> = []
	afterEach(async () => {
		for (const temp of temps) await temp.cleanup()
		temps.length = 0
	})
	async function project(
		layout: UpgradeLayout,
		extra: Parameters<typeof writeFixtureProject>[1] = { layout },
	) {
		const dir = await createTempDir()
		temps.push(dir)
		const original = await writeFixtureProject(dir.path, { ...extra, layout })
		return { root: dir.path, original }
	}

	it.each([
		['npm', 'npm install', 'npx --no-install kora doctor --skip-network'],
		['pnpm', 'pnpm install --no-frozen-lockfile', 'pnpm exec kora doctor --skip-network'],
		['yarn', 'yarn install', 'yarn kora doctor --skip-network'],
		['bun', 'bun install', 'bun run kora doctor --skip-network'],
	] as const)(
		'bumps all Kora packages together, installs, then runs doctor (%s)',
		async (layout, install, doctor) => {
			const { root } = await project(layout)
			const h = harness()
			const result = await runUpgrade(options(root), h.deps)

			expect(result.status).toBe('upgraded')
			const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf-8')) as {
				dependencies: Record<string, string>
				devDependencies: Record<string, string>
			}
			expect(pkg.dependencies.korajs).toBe('^1.0.0-beta.15')
			expect(pkg.dependencies['@korajs/react']).toBe('^1.0.0-beta.15')
			expect(pkg.devDependencies['@korajs/cli']).toBe('^1.0.0-beta.15')
			expect(pkg.dependencies.react).toBe('^18.3.1')
			expect(h.commands).toEqual([`${install} @${root}`, `${doctor} @${root}`])
		},
	)

	it('--dry-run prints the plan and changes and runs nothing', async () => {
		const { root, original } = await project('pnpm')
		const h = harness()
		const result = await runUpgrade(options(root, { dryRun: true }), h.deps)

		expect(result.status).toBe('dry-run')
		expect(result.plan.changes).toHaveLength(3)
		expect(await readFile(join(root, 'package.json'), 'utf-8')).toBe(original)
		expect(h.commands).toEqual([])
		expect(h.lines.some((line) => line.includes('korajs  ^1.0.0-beta.14 -> ^1.0.0-beta.15'))).toBe(
			true,
		)
	})

	it('keeps each specifier style and warns about the mix', async () => {
		const { root } = await project('npm', {
			layout: 'npm',
			dependencies: { korajs: '1.0.0-beta.14', '@korajs/react': '~1.0.0-beta.14' },
			devDependencies: {},
		})
		const h = harness()
		await runUpgrade(options(root), h.deps)
		const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf-8')) as {
			dependencies: Record<string, string>
		}
		expect(pkg.dependencies).toEqual({ korajs: '1.0.0-beta.15', '@korajs/react': '~1.0.0-beta.15' })
		expect(h.lines.some((line) => line.startsWith('warn Specifiers mix styles'))).toBe(true)
	})

	it('--to pins an exact version instead of a dist-tag', async () => {
		const { root } = await project('npm')
		const h = harness()
		const result = await runUpgrade(options(root, { to: '1.0.0' }), h.deps)
		expect(result.plan.target).toEqual({ version: '1.0.0', source: 'to' })
		const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf-8')) as {
			dependencies: Record<string, string>
		}
		expect(pkg.dependencies.korajs).toBe('^1.0.0')
	})

	it('exits through UpgradeError with a clear message when doctor fails', async () => {
		const { root } = await project('npm')
		const h = harness((_command, args) => (args.includes('doctor') ? 1 : 0))
		await expect(runUpgrade(options(root), h.deps)).rejects.toMatchObject({
			code: 'UPGRADE_DOCTOR_FAILED',
			message: expect.stringContaining('kora doctor reported blocking issues'),
		})
		expect(h.commands).toHaveLength(2)
	})

	it('reports a failed install and does not run doctor', async () => {
		const { root } = await project('npm')
		const h = harness((command) => (command === 'npm' ? 1 : 0))
		await expect(runUpgrade(options(root), h.deps)).rejects.toMatchObject({
			code: 'UPGRADE_INSTALL_FAILED',
		})
		expect(h.commands).toHaveLength(1)
	})

	it('does nothing when every package is already on the target', async () => {
		const { root, original } = await project('npm', {
			layout: 'npm',
			dependencies: { korajs: '^1.0.0-beta.15' },
			devDependencies: {},
		})
		const h = harness()
		const result = await runUpgrade(options(root), h.deps)
		expect(result.status).toBe('up-to-date')
		expect(await readFile(join(root, 'package.json'), 'utf-8')).toBe(original)
		expect(h.commands).toEqual([])
	})

	it('refuses to write in a non-interactive shell without --yes', async () => {
		const { root, original } = await project('npm')
		const h = harness()
		await expect(runUpgrade(options(root, { yes: false }), h.deps)).rejects.toMatchObject({
			code: 'UPGRADE_CONFIRMATION_REQUIRED',
		})
		expect(await readFile(join(root, 'package.json'), 'utf-8')).toBe(original)
	})

	it('asks for confirmation interactively and honors a no', async () => {
		const { root, original } = await project('npm')
		const h = harness(undefined, false)
		const result = await runUpgrade(options(root, { yes: false, interactive: true }), h.deps)
		expect(result.status).toBe('cancelled')
		expect(await readFile(join(root, 'package.json'), 'utf-8')).toBe(original)
		expect(h.commands).toEqual([])
	})

	it('fails before writing when the target cannot be resolved', async () => {
		const { root, original } = await project('npm')
		const h = harness()
		await expect(runUpgrade(options(root, { tag: 'canary' }), h.deps)).rejects.toMatchObject({
			code: 'UPGRADE_TAG_NOT_FOUND',
		})
		await expect(runUpgrade(options(root, { tag: 'next' }), h.deps)).rejects.toMatchObject({
			code: 'UPGRADE_INVALID_TAG',
		})
		await expect(
			runUpgrade(options(root, { tag: 'beta', to: '1.0.0' }), h.deps),
		).rejects.toBeInstanceOf(UpgradeError)
		expect(await readFile(join(root, 'package.json'), 'utf-8')).toBe(original)
		expect(h.commands).toEqual([])
	})

	it('never touches lockfiles or node_modules', async () => {
		const { root } = await project('pnpm')
		await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
		const h = harness()
		await runUpgrade(options(root), h.deps)
		expect(await readFile(join(root, 'pnpm-lock.yaml'), 'utf-8')).toBe('lockfileVersion: 9\n')
	})

	it('prints upgrade diagnostics for legacy JSON serialization and nullable defaults', async () => {
		const { root } = await project('npm', {
			layout: 'npm',
			dependencies: { korajs: '^1.0.0-beta.12' },
			devDependencies: {},
			files: {
				'src/schema.ts': [
					"import { defineSchema, t } from 'korajs'",
					'export default defineSchema({ version: 1, collections: { forms: { fields: {',
					'  fields: t.json(),',
					"  status: t.string().default('draft'),",
					'} } } })',
				].join('\n'),
				'src/use.ts': [
					'await app.forms.insert({ fields: JSON.stringify([]) })',
					'const draft = form.status === null',
					'const s = new DynamicProtobufSerializer()',
				].join('\n'),
			},
		})
		const h = harness()
		const result = await runUpgrade(options(root, { dryRun: true }), h.deps)
		const ids = result.codemods.filter((c) => c.findings.length > 0).map((c) => c.codemod.id)
		expect(ids).toEqual([
			'wire-format-serializers',
			'json-field-string-values',
			'defaulted-field-null-checks',
		])
		expect(h.lines.some((line) => line.includes('src/use.ts:1'))).toBe(true)
		expect(h.lines.some((line) => line.includes('More: https://'))).toBe(true)
	})

	it('fails when the project has no Kora package with a registry version', async () => {
		const { root } = await project('npm', {
			layout: 'npm',
			dependencies: { korajs: 'workspace:*' },
			devDependencies: {},
		})
		await expect(runUpgrade(options(root), harness().deps)).rejects.toMatchObject({
			code: 'UPGRADE_NO_PACKAGES',
		})
	})

	it('--to makes no registry lookup', async () => {
		const { root } = await project('npm')
		const h = harness()
		await runUpgrade(options(root, { to: '1.0.0-beta.99' }), h.deps)
		expect(h.lookupCalls).toEqual([])
	})

	it('tells the developer to add @korajs/cli when the kora binary is missing', async () => {
		const { root } = await project('pnpm')
		const h = harness(undefined, true, false)
		await expect(runUpgrade(options(root), h.deps)).rejects.toMatchObject({
			code: 'UPGRADE_DOCTOR_UNAVAILABLE',
			message: expect.stringContaining('pnpm add -D @korajs/cli@1.0.0-beta.15'),
		})
		expect(h.commands).toHaveLength(1)
	})

	it('reports a doctor that cannot be spawned apart from one that found problems', async () => {
		const { root } = await project('npm')
		const h = harness((_command, args) => {
			if (args.includes('doctor')) throw new Error('spawn npx ENOENT')
			return 0
		})
		await expect(runUpgrade(options(root), h.deps)).rejects.toMatchObject({
			code: 'UPGRADE_DOCTOR_UNAVAILABLE',
			message: expect.stringContaining('spawn npx ENOENT'),
		})
	})

	it('lists every modified file and how to restore after an install failure', async () => {
		const { root } = await project('npm')
		const h = harness((command) => (command === 'npm' ? 1 : 0))
		await expect(runUpgrade(options(root), h.deps)).rejects.toMatchObject({
			code: 'UPGRADE_INSTALL_FAILED',
			message: expect.stringMatching(/Modified: package\.json\..*git checkout -- package\.json/),
		})
	})

	it('reports an install that cannot be started', async () => {
		const { root } = await project('npm')
		const h = harness(() => {
			throw new Error('spawn npm ENOENT')
		})
		await expect(runUpgrade(options(root), h.deps)).rejects.toMatchObject({
			code: 'UPGRADE_INSTALL_FAILED',
		})
	})

	describe('ancestor lookups stay inside the project', () => {
		it('ignores a stray lockfile and an unreadable package.json above the project', async () => {
			const outer = await createTempDir()
			temps.push(outer)
			// A stray ~/package.json that would throw if it were ever read, plus a lockfile.
			await writeFile(join(outer.path, 'package.json'), '{ not json')
			await writeFile(join(outer.path, 'package-lock.json'), '')
			const app = join(outer.path, 'work', 'app')
			await mkdir(app, { recursive: true })
			await writeFixtureProject(app, { layout: 'pnpm', noLockfile: true })
			const h = harness()
			const result = await runUpgrade(options(app), h.deps)
			expect(result.project.installDir).toBe(app)
			expect(result.project.packageManagerSource).toBe('fallback')
			expect(h.commands[0]).toBe(`npm install @${app}`)
		})

		it('ignores a workspace root whose globs do not contain the project', async () => {
			const outer = await createTempDir()
			temps.push(outer)
			await writeFile(
				join(outer.path, 'package.json'),
				JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
			)
			await writeFile(join(outer.path, 'pnpm-lock.yaml'), '')
			const app = join(outer.path, 'other', 'app')
			await mkdir(app, { recursive: true })
			await writeFixtureProject(app, { layout: 'npm', noLockfile: true })
			const result = await runUpgrade(options(app, { dryRun: true }), harness().deps)
			expect(result.project.installDir).toBe(app)
		})

		it('uses a workspace root that does contain the project', async () => {
			const outer = await createTempDir()
			temps.push(outer)
			await writeFile(
				join(outer.path, 'package.json'),
				JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
			)
			await writeFile(join(outer.path, 'yarn.lock'), '')
			const app = join(outer.path, 'packages', 'app')
			await mkdir(app, { recursive: true })
			await writeFixtureProject(app, { layout: 'npm', noLockfile: true })
			const h = harness()
			const result = await runUpgrade(options(app), h.deps)
			expect(result.project.installDir).toBe(outer.path)
			expect(result.project.packageManager).toBe('yarn')
			expect(h.commands[0]).toBe(`yarn install @${outer.path}`)
		})

		it('stops at the repository root even when a matching workspace sits above it', async () => {
			const outer = await createTempDir()
			temps.push(outer)
			await writeFile(
				join(outer.path, 'package.json'),
				JSON.stringify({ name: 'root', workspaces: ['**'] }),
			)
			await writeFile(join(outer.path, 'package-lock.json'), '')
			const repo = join(outer.path, 'repo')
			const app = join(repo, 'app')
			await mkdir(join(repo, '.git'), { recursive: true })
			await mkdir(app, { recursive: true })
			await writeFixtureProject(app, { layout: 'npm', noLockfile: true })
			const result = await runUpgrade(options(app, { dryRun: true }), harness().deps)
			expect(result.project.installDir).toBe(app)
		})

		it('ignores a pnpm-workspace.yaml above the project that does not list it', async () => {
			const outer = await createTempDir()
			temps.push(outer)
			await writeFile(
				join(outer.path, 'pnpm-workspace.yaml'),
				['packages:', "  - 'libs/*'", 'catalog:', '  korajs: 1.0.0-beta.1', ''].join('\n'),
			)
			const app = join(outer.path, 'app')
			await mkdir(app, { recursive: true })
			await writeFixtureProject(app, { layout: 'npm' })
			const result = await runUpgrade(options(app, { dryRun: true }), harness().deps)
			expect(result.project.specifiers.some((s) => s.format === 'pnpm-workspace')).toBe(false)
		})
	})

	it('warns about overrides it cannot rewrite instead of ignoring them', async () => {
		const { root } = await project('npm', {
			layout: 'npm',
			extra: {
				overrides: { react: { '@korajs/core': '1.0.0-beta.1' } },
				resolutions: { '**/@korajs/core': '1.0.0-beta.1' },
			},
		})
		const h = harness()
		await runUpgrade(options(root, { dryRun: true }), h.deps)
		const warnings = h.lines.filter(
			(line) => line.startsWith('warn') && line.includes('does not rewrite'),
		)
		expect(warnings).toHaveLength(2)
		expect(warnings.join('\n')).toContain('**/@korajs/core')
	})

	it('refuses an invalid package.json with a message naming the file', async () => {
		const { root } = await project('npm')
		await writeFile(join(root, 'package.json'), '{ "name": ')
		await expect(runUpgrade(options(root), harness().deps)).rejects.toMatchObject({
			code: 'UPGRADE_INVALID_PACKAGE_JSON',
			message: expect.stringContaining(join(root, 'package.json')),
		})
	})
})
