import { readFile, writeFile } from 'node:fs/promises'
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
		['pnpm', 'pnpm install', 'pnpm exec kora doctor --skip-network'],
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
})
