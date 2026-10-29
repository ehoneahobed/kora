import { access, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { PackageManager } from '../types'
import { PACKAGE_MANAGERS } from '../types'

/**
 * Project inspection for `kora upgrade`: which package manager the project uses and where
 * every Kora package version is declared (dependencies, overrides, pnpm catalogs).
 *
 * Everything here is read-only. Lockfiles and node_modules are never opened for writing.
 */

/** `korajs` or `@korajs/<name>`. `create-kora-app` is a scaffolder, never a dependency. */
const KORA_PACKAGE_NAME = /^(korajs|@korajs\/[a-z0-9][a-z0-9._-]*)$/

/** True for the names `kora upgrade` keeps on one version. */
export function isKoraPackageName(name: string): boolean {
	return KORA_PACKAGE_NAME.test(name)
}

/** Where a package.json specifier lives, as a key path into the parsed manifest. */
export interface PackageJsonSpecifier {
	format: 'package-json'
	/** Absolute path of the package.json. */
	file: string
	/** Human label: `dependencies`, `devDependencies`, `pnpm.overrides`, ... */
	section: string
	/** Key path to the containing object, e.g. `['pnpm', 'overrides']`. */
	path: string[]
	name: string
	spec: string
}

/** Where a pnpm-workspace.yaml specifier lives. */
export interface WorkspaceYamlSpecifier {
	format: 'pnpm-workspace'
	/** Absolute path of the pnpm-workspace.yaml. */
	file: string
	/** `catalog`, `catalogs.<name>` or `overrides`. */
	section: string
	/** Zero-based line index. */
	line: number
	name: string
	spec: string
}

export type KoraSpecifier = PackageJsonSpecifier | WorkspaceYamlSpecifier

export interface KoraProject {
	/** Absolute project root (the directory of the project's package.json). */
	root: string
	packageManager: PackageManager
	packageManagerSource: 'packageManager-field' | 'lockfile' | 'fallback'
	/** Directory the install runs in: where the lockfile lives, else the project root. */
	installDir: string
	specifiers: KoraSpecifier[]
	/** Notes for the plan output (several lockfiles, no lockfile, ...). */
	warnings: string[]
}

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
	['pnpm-lock.yaml', 'pnpm'],
	['yarn.lock', 'yarn'],
	['bun.lock', 'bun'],
	['bun.lockb', 'bun'],
	['package-lock.json', 'npm'],
	['npm-shrinkwrap.json', 'npm'],
]

const PACKAGE_JSON_DEPENDENCY_SECTIONS = [
	'dependencies',
	'devDependencies',
	'optionalDependencies',
] as const

async function exists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads and parses a package.json; returns null when absent, throws on invalid JSON. */
export async function readPackageJson(path: string): Promise<Record<string, unknown> | null> {
	let text: string
	try {
		text = await readFile(path, 'utf-8')
	} catch {
		return null
	}
	const parsed: unknown = JSON.parse(text)
	return isRecord(parsed) ? parsed : null
}

function packageManagerFromField(pkg: Record<string, unknown>): PackageManager | null {
	const field = pkg.packageManager
	if (typeof field !== 'string') return null
	const name = field.split('@')[0]
	return PACKAGE_MANAGERS.find((pm) => pm === name) ?? null
}

interface LockfileHit {
	dir: string
	managers: PackageManager[]
}

/** Walks up from `start` to the first directory that holds a lockfile. */
async function findLockfileDir(start: string): Promise<LockfileHit | null> {
	let current = start
	for (;;) {
		const managers: PackageManager[] = []
		for (const [file, pm] of LOCKFILES) {
			if ((await exists(join(current, file))) && !managers.includes(pm)) managers.push(pm)
		}
		if (managers.length > 0) return { dir: current, managers }
		const parent = dirname(current)
		if (parent === current) return null
		current = parent
	}
}

async function findWorkspaceYaml(start: string): Promise<string | null> {
	let current = start
	for (;;) {
		const candidate = join(current, 'pnpm-workspace.yaml')
		if (await exists(candidate)) return candidate
		const parent = dirname(current)
		if (parent === current) return null
		current = parent
	}
}

function collectPackageJsonSpecifiers(
	pkg: Record<string, unknown>,
	file: string,
	sections: ReadonlyArray<{ label: string; path: string[] }>,
): PackageJsonSpecifier[] {
	const found: PackageJsonSpecifier[] = []
	for (const { label, path } of sections) {
		let node: unknown = pkg
		for (const key of path) {
			node = isRecord(node) ? node[key] : undefined
		}
		if (!isRecord(node)) continue
		for (const [name, spec] of Object.entries(node)) {
			if (isKoraPackageName(name) && typeof spec === 'string') {
				found.push({ format: 'package-json', file, section: label, path, name, spec })
			}
		}
	}
	return found
}

const YAML_ENTRY = /^(\s+)(["']?)([^"'\s:]+)\2(\s*:\s*)(["']?)([^"'\s#]+)\5(\s*(?:#.*)?)$/
const YAML_HEADER = /^(\s+)(["']?)([^"'\s:]+)\2\s*:\s*(?:#.*)?$/

/**
 * Finds Kora entries in a pnpm-workspace.yaml `catalog`, `catalogs` and `overrides`.
 * A line scanner rather than a YAML parser: these sections are flat `name: version` maps,
 * and scanning lets the rewrite touch only the version, keeping quotes and comments.
 */
export function scanPnpmWorkspaceYaml(text: string, file: string): WorkspaceYamlSpecifier[] {
	const found: WorkspaceYamlSpecifier[] = []
	const lines = text.split(/\r?\n/)
	let top: string | null = null
	let catalogName: string | null = null
	let catalogHeaderIndent = -1
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? ''
		if (line.trim() === '' || line.trimStart().startsWith('#')) continue
		if (!/^\s/.test(line)) {
			const key = /^([A-Za-z]+)\s*:/.exec(line)
			top = key?.[1] ?? null
			catalogName = null
			catalogHeaderIndent = -1
			continue
		}
		if (top === 'catalogs') {
			const header = YAML_HEADER.exec(line)
			if (header) {
				const indent = header[1]?.length ?? 0
				if (catalogHeaderIndent === -1 || indent <= catalogHeaderIndent) {
					catalogHeaderIndent = indent
					catalogName = header[3] ?? null
				}
				continue
			}
		}
		if (top !== 'catalog' && top !== 'catalogs' && top !== 'overrides') continue
		const entry = YAML_ENTRY.exec(line)
		const name = entry?.[3]
		const spec = entry?.[6]
		if (!name || !spec || !isKoraPackageName(name)) continue
		if (top === 'catalogs' && catalogName === null) continue
		const section = top === 'catalogs' ? `catalogs.${catalogName}` : top
		found.push({ format: 'pnpm-workspace', file, section, line: i, name, spec })
	}
	return found
}

/**
 * Rewrites the version of one pnpm-workspace.yaml line, keeping indentation, quoting and the
 * trailing comment. Returns the line unchanged when it no longer matches the scanned shape.
 */
export function rewriteYamlSpecLine(line: string, newSpec: string): string {
	const entry = YAML_ENTRY.exec(line)
	if (!entry) return line
	const [, indent, quote, name, colon, valueQuote, , tail] = entry
	return `${indent}${quote}${name}${quote}${colon}${valueQuote}${newSpec}${valueQuote}${tail}`
}

/**
 * Inspects the project at `root`: detects the package manager (the `packageManager` field,
 * then the nearest lockfile, then `fallbackPackageManager`) and collects every Kora specifier
 * from package.json (`dependencies`, `devDependencies`, `optionalDependencies`, `overrides`,
 * `pnpm.overrides`, `resolutions`) and from a pnpm-workspace.yaml found at or above the root.
 *
 * @param root - Directory containing the project's package.json
 * @param fallbackPackageManager - Used when neither the field nor a lockfile decides
 */
export async function inspectProject(
	root: string,
	fallbackPackageManager: PackageManager,
): Promise<KoraProject> {
	const projectRoot = resolve(root)
	const packageJsonPath = join(projectRoot, 'package.json')
	const pkg = await readPackageJson(packageJsonPath)
	if (!pkg) {
		throw new Error(`No readable package.json at ${packageJsonPath}`)
	}

	const warnings: string[] = []
	const lockfile = await findLockfileDir(projectRoot)
	const fieldManager = packageManagerFromField(pkg)

	let packageManager: PackageManager
	let packageManagerSource: KoraProject['packageManagerSource']
	if (fieldManager) {
		packageManager = fieldManager
		packageManagerSource = 'packageManager-field'
	} else if (lockfile) {
		packageManager = lockfile.managers[0] ?? fallbackPackageManager
		packageManagerSource = 'lockfile'
	} else {
		packageManager = fallbackPackageManager
		packageManagerSource = 'fallback'
		warnings.push(
			`No lockfile found; assuming ${packageManager}. Install will create one: commit it.`,
		)
	}
	if (lockfile && lockfile.managers.length > 1) {
		warnings.push(
			`Several lockfiles found in ${lockfile.dir} (${lockfile.managers.join(', ')}); using ${packageManager}. Remove the lockfile you do not use.`,
		)
	}
	if (lockfile && !lockfile.managers.includes(packageManager)) {
		warnings.push(
			`package.json declares ${packageManager} but the lockfile belongs to ${lockfile.managers.join('/')}.`,
		)
	}

	const installDir = lockfile?.dir ?? projectRoot
	const specifiers: KoraSpecifier[] = collectPackageJsonSpecifiers(pkg, packageJsonPath, [
		...PACKAGE_JSON_DEPENDENCY_SECTIONS.map((section) => ({ label: section, path: [section] })),
		{ label: 'overrides', path: ['overrides'] },
		{ label: 'pnpm.overrides', path: ['pnpm', 'overrides'] },
		{ label: 'resolutions', path: ['resolutions'] },
	])

	// A workspace root above the project can hold the overrides that would pin old versions.
	if (installDir !== projectRoot) {
		const rootPackageJsonPath = join(installDir, 'package.json')
		const rootPkg = await readPackageJson(rootPackageJsonPath)
		if (rootPkg) {
			specifiers.push(
				...collectPackageJsonSpecifiers(rootPkg, rootPackageJsonPath, [
					{ label: 'overrides', path: ['overrides'] },
					{ label: 'pnpm.overrides', path: ['pnpm', 'overrides'] },
					{ label: 'resolutions', path: ['resolutions'] },
				]),
			)
		}
	}

	const workspaceYaml = await findWorkspaceYaml(projectRoot)
	if (workspaceYaml) {
		const text = await readFile(workspaceYaml, 'utf-8')
		specifiers.push(...scanPnpmWorkspaceYaml(text, workspaceYaml))
	}

	return {
		root: projectRoot,
		packageManager,
		packageManagerSource,
		installDir,
		specifiers,
		warnings,
	}
}
