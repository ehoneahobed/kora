import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PackageRegistryInfo, RegistryLookup } from '../../src/upgrade/registry'

/**
 * Fixture projects for `kora upgrade` tests: one per package-manager layout. Each has a
 * lockfile stub (the upgrade never reads its contents, only its name) and a package.json
 * with a deliberate mix of specifier styles.
 */
export type UpgradeLayout = 'npm' | 'pnpm' | 'yarn' | 'bun'

const LOCKFILE: Record<UpgradeLayout, string> = {
	npm: 'package-lock.json',
	pnpm: 'pnpm-lock.yaml',
	yarn: 'yarn.lock',
	bun: 'bun.lock',
}

export interface FixtureProjectOptions {
	layout: UpgradeLayout
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	/** Extra top-level package.json fields (overrides, resolutions, pnpm, packageManager). */
	extra?: Record<string, unknown>
	/** Extra files, relative path to text. */
	files?: Record<string, string>
	/** Skip the lockfile stub. */
	noLockfile?: boolean
	/** Indent used for package.json (default two spaces). */
	indent?: string
}

export const DEFAULT_KORA_DEPENDENCIES: Record<string, string> = {
	korajs: '^1.0.0-beta.14',
	'@korajs/react': '^1.0.0-beta.14',
	react: '^18.3.1',
}

export const DEFAULT_KORA_DEV_DEPENDENCIES: Record<string, string> = {
	'@korajs/cli': '^1.0.0-beta.14',
	typescript: '^5.7.3',
}

/** Writes a fixture project into `directory` and returns the package.json text it wrote. */
export async function writeFixtureProject(
	directory: string,
	options: FixtureProjectOptions,
): Promise<string> {
	const pkg = {
		name: 'fixture-app',
		private: true,
		dependencies: options.dependencies ?? DEFAULT_KORA_DEPENDENCIES,
		devDependencies: options.devDependencies ?? DEFAULT_KORA_DEV_DEPENDENCIES,
		...(options.extra ?? {}),
	}
	const text = `${JSON.stringify(pkg, null, options.indent ?? 2)}\n`
	await writeFile(join(directory, 'package.json'), text, 'utf-8')
	if (!options.noLockfile) {
		await writeFile(join(directory, LOCKFILE[options.layout]), '', 'utf-8')
	}
	for (const [path, content] of Object.entries(options.files ?? {})) {
		const absolute = join(directory, path)
		await mkdir(dirname(absolute), { recursive: true })
		await writeFile(absolute, content, 'utf-8')
	}
	return text
}

/**
 * A registry lookup backed by a table, so no test touches the network. Every name in
 * `packages` (default: the Kora packages the fixtures use) shares the same dist-tags and
 * versions; pass `perPackage` to make one differ.
 */
export function createFakeRegistry(options: {
	distTags: Record<string, string>
	versions: string[]
	packages?: string[]
	perPackage?: Record<string, PackageRegistryInfo | null>
}): RegistryLookup & { calls: string[] } {
	const known = new Set(
		options.packages ?? [
			'korajs',
			'@korajs/react',
			'@korajs/cli',
			'@korajs/server',
			'@korajs/core',
		],
	)
	const calls: string[] = []
	const lookup = async (name: string): Promise<PackageRegistryInfo | null> => {
		calls.push(name)
		if (options.perPackage && name in options.perPackage) return options.perPackage[name] ?? null
		if (!known.has(name)) return null
		return { distTags: options.distTags, versions: options.versions }
	}
	return Object.assign(lookup, { calls })
}
